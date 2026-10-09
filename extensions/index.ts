/**
 * pi-rename — name a pi session from its conversation, and put that name in the
 * terminal title.
 *
 * Two behaviours, nothing else:
 *   1. Auto-rename: when a fresh session finishes its first exchange, one small
 *      model call turns the conversation into a short name and stores it as the
 *      session name (the same store pi's `/name` uses). A session that already
 *      has a name is never renamed automatically.
 *   2. `/rename` — rename the current session from the last 5 turns,
 *      overwriting any previous name. `/rename <text>` uses that text as the
 *      name. `/rename on|off` toggles behaviour 1. `/rename model <provider/id>`
 *      picks the model used for naming (empty = the session's own model).
 *      `/rename vscode` re-runs the VS Code settings check on demand.
 *   3. VS Code tab title — at session start on Windows (or via `/rename vscode`
 *      anywhere), if a user-level settings.json exists (VS Code is installed),
 *      `terminal.integrated.tabs.title` is set to "${sequence}" so the tab
 *      label follows the shell-reported title that pi's setTitle emits.
 *
 * After every rename the session name is also pushed to the terminal title with
 * `ctx.ui.setTitle()`, which emits an OSC title sequence, so a VS Code terminal
 * tab (pwsh or Git Bash) follows the name. See README for the VS Code setting
 * that makes the tab label track shell-reported titles.
 *
 * Naming rules (see naming.ts): every user prompt of the window goes in full,
 * each turn contributes only its last assistant text block (the final answer,
 * not tool-call chatter), the name is capped at 15 units where one CJK
 * character or one alphabetic word is one unit, and the name's language follows
 * the user's messages.
 *
 * Settings persist in ~/.pi/agent/pi-rename/config.json (override the directory
 * with PI_RENAME_CONFIG_DIR).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildNameRequest,
	collectTurns,
	fallbackName,
	recentTurns,
	sanitizeLiteralName,
	sanitizeName,
	type EntryLike,
	type Turn,
} from "./naming.ts";
import { ensureSequenceTitle } from "./vscode.ts";

const ENTRY_TYPE = "pi-rename";

/**
 * Thinking level sent with the naming call — the ONLY model parameter set.
 * It cannot be omitted: on qwen-style relays the reasoning option IS the
 * thinking switch, and omitting it sends enable_thinking:false, which
 * thinking-only relays reject with “不支持关闭思考”. So the level is always a
 * real one (never off/undefined) and everything else — temperature, output
 * cap, cache retention — is left at provider defaults; the prompt alone
 * controls what the answer looks like.
 */
const NAME_REASONING = "low";

/**
 * Cap every level's token budget at 1024. Some Anthropic-format relays treat
 * budget_tokens as a thinking-tier switch and reject anything above their
 * "low" tier with a misleading “不支持关闭思考” 400 (reproduced against a
 * glm-5.3-flash relay: budget 1024 → 200, 1025+ → 400). Naming never needs
 * deep thinking, and effort-style providers ignore this field entirely.
 */
const NAME_THINKING_BUDGETS = { minimal: 1024, low: 1024, medium: 1024, high: 1024 };

/** Levels accepted by config.json `reasoning` and `/rename reasoning`. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
type NameThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Config directory. Override with PI_RENAME_CONFIG_DIR (the tests use a temp dir). */
function configDir(): string {
	return process.env.PI_RENAME_CONFIG_DIR || join(homedir(), ".pi", "agent", "pi-rename");
}

function configFile(): string {
	return join(configDir(), "config.json");
}

interface RenameConfig {
	/** Rename new sessions automatically once the first exchange settles. */
	auto: boolean;
	/** Naming model ("provider/id" or an id substring). Empty = session model. */
	model: string;
	/** Thinking level for the naming call. */
	reasoning: NameThinkingLevel;
}

const DEFAULTS: RenameConfig = { auto: true, model: "", reasoning: NAME_REASONING };

function readBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		if (["false", "0", "off", "no", "none"].includes(lower)) return false;
		if (["true", "1", "on", "yes"].includes(lower)) return true;
	}
	return fallback;
}

function loadConfig(): RenameConfig {
	let stored: Record<string, unknown> = {};
	try {
		stored = JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
	} catch {
		stored = {};
	}
	return {
		// `autoName` was the original key; keep reading it so an old file survives.
		auto: readBoolean(stored.auto ?? stored.autoName, DEFAULTS.auto),
		model: typeof stored.model === "string" ? stored.model : DEFAULTS.model,
		// "off" was accepted by 1.1.x but it is the disable signal that thinking-only
		// relays reject, so stored "off" (and anything unknown) coerces to the default.
		reasoning: THINKING_LEVELS.includes(stored.reasoning as NameThinkingLevel)
			? (stored.reasoning as NameThinkingLevel)
			: DEFAULTS.reasoning,
	};
}

function saveConfig(config: RenameConfig): void {
	try {
		mkdirSync(configDir(), { recursive: true });
		const tmp = `${configFile()}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		renameSync(tmp, configFile());
	} catch {
		// Config persistence is best effort; naming still works for this run.
	}
}

/** Set once the VS Code settings.json patch has run for this process. */
let vscodeChecked = false;

/** Test seam: reset the once-per-process guard between harnesses. */
export function resetVscodeTitleCheck(): void {
	vscodeChecked = false;
}

/**
 * Make the VS Code terminal tab follow shell-reported titles. Runs at most
 * once per process; on Windows the default tab template ignores OSC
 * sequences, so the user-level settings.json needs
 * `"terminal.integrated.tabs.title": "${sequence}"` — patched automatically
 * when VS Code is installed (settings.json exists) and readable. Other
 * platforms keep their defaults unless /rename vscode is run by hand.
 */
function syncVscodeTitle(ctx: ExtensionContext, force = false): void {
	if (vscodeChecked && !force) return;
	vscodeChecked = true;
	if (process.platform !== "win32" && !force) return;
	const result = ensureSequenceTitle();
	ctx.ui.notify(result.message, result.status === "failed" ? "warning" : "info");
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	/** Set once auto-renaming has been handled for the current session. */
	let autoAttempted = false;
	/** Guards overlapping model calls. */
	let inflight: Promise<void> | undefined;

	// ---------------------------------------------------------------- helpers

	/** Push the session name into the terminal title. */
	function applyTitle(ctx: ExtensionContext): void {
		const name = pi.getSessionName();
		if (name) ctx.ui.setTitle(sanitizeLiteralName(name));
	}

	function pickModel(ctx: ExtensionContext) {
		const available = ctx.modelRegistry.getAvailable();
		if (!config.model) return ctx.model ?? available[0];
		const needle = config.model.toLowerCase();
		const exact = available.find((model) => `${model.provider}/${model.id}`.toLowerCase() === needle);
		if (exact) return exact;
		const fuzzy = available.find(
			(model) =>
				model.id.toLowerCase() === needle ||
				`${model.provider}/${model.id}`.toLowerCase().includes(needle) ||
				model.name.toLowerCase().includes(needle),
		);
		if (fuzzy) return fuzzy;
		ctx.ui.notify(`pi-rename: no model matches “${config.model}”, using the session model`, "warning");
		return ctx.model ?? available[0];
	}

	/** Ask the model for a name; fall back to the first prompt line on failure. */
	async function generateName(ctx: ExtensionContext, turns: Turn[]): Promise<string> {
		const first = turns[0];
		const { systemPrompt, prompt } = buildNameRequest(turns);
		const model = pickModel(ctx);
		if (!model) return fallbackName(first?.user ?? "");
		try {
			// streamSimple with ONLY the reasoning level + capped thinking budgets set.
			// Everything else stays at provider defaults; the prompt alone shapes the
			// answer. reasoning must be a real level (never undefined) and the budget
			// must stay ≤ 1024 — see NAME_REASONING / NAME_THINKING_BUDGETS above.
			const response = await ctx.modelRegistry
				.streamSimple(
					model,
					{ systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
					{ reasoning: config.reasoning, thinkingBudgets: NAME_THINKING_BUDGETS },
				)
				.result();
			if (response.stopReason === "error") throw new Error(response.errorMessage ?? "model error");
			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join(" ");
			const name = sanitizeName(text);
			if (name) return name;
			// Say why a fallback name appeared rather than failing silently.
			ctx.ui.notify(
				`pi-rename: model returned no usable name (stopReason: ${response.stopReason}), using the first prompt`,
				"warning",
			);
			return fallbackName(first?.user ?? "");
		} catch (error) {
			ctx.ui.notify(
				`pi-rename: naming call failed (${error instanceof Error ? error.message : String(error)})`,
				"warning",
			);
			return fallbackName(first?.user ?? "");
		}
	}

	/** Store the name through pi, then mirror it into the terminal title. */
	function applyName(name: string, ctx: ExtensionContext): void {
		pi.setSessionName(name);
		applyTitle(ctx);
	}

	async function renameFromConversation(ctx: ExtensionContext, reason: "auto" | "manual"): Promise<void> {
		if (inflight) await inflight.catch(() => {});
		const turns = recentTurns(collectTurns(ctx.sessionManager.getBranch() as unknown as EntryLike[]));
		if (turns.length === 0) {
			if (reason === "manual") ctx.ui.notify("pi-rename: nothing to rename yet", "warning");
			return;
		}
		const task = (async () => {
			const name = await generateName(ctx, turns);
			if (!name) {
				if (reason === "manual") ctx.ui.notify("pi-rename: could not produce a name", "warning");
				return;
			}
			// Auto-renaming never overwrites a name somebody already chose.
			if (reason === "auto" && pi.getSessionName()) return;
			applyName(name, ctx);
			ctx.ui.notify(
				reason === "auto" ? `pi-rename: session renamed to “${name}”` : `pi-rename: renamed to “${name}”`,
				"info",
			);
		})();
		inflight = task;
		try {
			await task;
		} finally {
			if (inflight === task) inflight = undefined;
		}
	}

	// ---------------------------------------------------------------- command

	pi.registerCommand("rename", {
		description:
			"Rename this session from the conversation (/rename [name|on|off|model|reasoning|vscode <args>])",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const keyword = (sub ?? "").toLowerCase();

			// /rename — rename from the last 5 turns, overwriting the current name.
			if (!trimmed) {
				await renameFromConversation(ctx, "manual");
				return;
			}

			// /rename on|off — auto-rename switch.
			if (keyword === "on" || keyword === "off") {
				config.auto = keyword === "on";
				saveConfig(config);
				ctx.ui.notify(`pi-rename: auto-rename ${config.auto ? "on" : "off"}`, "info");
				return;
			}

			// /rename model — which model does the naming.
			if (keyword === "model") {
				const pattern = rest.join(" ").trim();

				// `show` prints the effective model without changing anything.
				if (pattern === "show") {
					const model = pickModel(ctx);
					ctx.ui.notify(
						model
							? `pi-rename: naming model is ${config.model ? "(configured) " : "(session) "}${model.provider}/${model.id}`
							: "pi-rename: no model available",
						"info",
					);
					return;
				}

				// No argument → interactive picker instead of asking the user to type
				// provider/id from memory. `show` / `list` prints instead; print/json
				// mode (no dialog UI) also degrades to a printed list.
				if (!pattern || pattern === "select" || pattern === "list") {
					const available = ctx.modelRegistry.getAvailable();
					if (available.length === 0) {
						ctx.ui.notify("pi-rename: no models available", "warning");
						return;
					}
					const sessionEntry = `session model${ctx.model ? ` (${ctx.model.provider}/${ctx.model.id})` : ""}`;
					// Group by provider so the list reads like pi's own model switcher.
					const sorted = [
						sessionEntry,
						...available
							.map((m) => `${m.provider}/${m.id}`)
							.sort((a, b) => a.localeCompare(b)),
					];
					const current = pickModel(ctx);
					const header = `pi-rename: naming model${current ? ` (now ${current.provider}/${current.id})` : ""}`;
					const printList = () => {
						ctx.ui.notify(`${header}; available: ${sorted.slice(1).join(", ")}`, "info");
					};

					if (!ctx.hasUI || pattern === "list") {
						printList();
						return;
					}
					const chosen = await ctx.ui.select(header, sorted);
					if (chosen === undefined) return; // picker cancelled
					if (chosen === sessionEntry) {
						config.model = "";
						saveConfig(config);
						ctx.ui.notify("pi-rename: naming model → session model", "info");
						return;
					}
					config.model = chosen;
					saveConfig(config);
					ctx.ui.notify(`pi-rename: naming model → ${chosen}`, "info");
					return;
				}

				// Explicit pattern: keep the typed path for scripts and muscle memory.
				config.model = pattern === "default" || pattern === "clear" ? "" : pattern;
				saveConfig(config);
				ctx.ui.notify(
					config.model ? `pi-rename: naming model → ${config.model}` : "pi-rename: naming model → session model",
					"info",
				);
				return;
			}

			// /rename reasoning [level] — thinking level for the naming call. "off" is
			// deliberately not offered: omitting the level is what turns thinking off,
			// and thinking-only relays reject that outright.
			if (keyword === "reasoning" || keyword === "thinking") {
				const level = rest.join(" ").trim().toLowerCase();
				if (!level) {
					ctx.ui.notify(
						`pi-rename: reasoning is “${config.reasoning}” (minimal | low | medium | high)`,
						"info",
					);
					return;
				}
				if (!THINKING_LEVELS.includes(level as NameThinkingLevel)) {
					ctx.ui.notify(
						`pi-rename: unknown reasoning “${level}” (minimal | low | medium | high; "off" would send the disable signal thinking-only models reject)`,
						"warning",
					);
					return;
				}
				config.reasoning = level as NameThinkingLevel;
				saveConfig(config);
				ctx.ui.notify(`pi-rename: reasoning → ${config.reasoning}`, "info");
				return;
			}

			// /rename vscode — (re)run the VS Code tab-title settings check on
			// any platform, and report what happened. Exact match only, so a
			// literal name that merely starts with "vscode" still works.
			if (trimmed === "vscode") {
				syncVscodeTitle(ctx, true);
				return;
			}

			// /rename <text> — use the text as the name.
			const literal = sanitizeLiteralName(trimmed);
			if (!literal) {
				ctx.ui.notify("pi-rename: empty name", "warning");
				return;
			}
			applyName(literal, ctx);
			ctx.ui.notify(`pi-rename: renamed to “${pi.getSessionName()}”`, "info");
		},
	});

	// ------------------------------------------------------------------ events

	pi.on("session_start", async (_event, ctx) => {
		// Auto-rename already handled in this session? The custom entry survives
		// reloads and resumes, so the branch scan is the source of truth.
		autoAttempted = ctx.sessionManager
			.getBranch()
			.some((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
		// A resumed session keeps its name; make sure the tab reflects it.
		applyTitle(ctx);
		// Windows tab labels do not follow OSC sequences by default; patch the
		// VS Code user settings once per process when they exist (best effort).
		syncVscodeTitle(ctx);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		// pi's own `/name` and `--name` change the name without a custom title.
		applyTitle(ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) return;
		if (!config.auto || autoAttempted) return;
		if (pi.getSessionName()) {
			autoAttempted = true;
			return;
		}
		// Non-interactive runs keep pi's behaviour (no extra model call).
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		autoAttempted = true;
		// Record the attempt so a reload/resume does not spend another call.
		pi.appendEntry(ENTRY_TYPE, { autoRenamed: true, at: new Date().toISOString() });
		// Fire and forget: the run is over, the name arrives as soon as it can.
		void renameFromConversation(ctx, "auto");
	});
}
