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

const ENTRY_TYPE = "pi-rename";

/**
 * Output cap for the naming call. A name is a handful of tokens, but providers
 * that emit reasoning content anyway (some OpenAI-compatible relays) bill that
 * against this cap too, so 64 was too tight and left no text at all.
 */
const NAME_MAX_TOKENS = 512;

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
}

const DEFAULTS: RenameConfig = { auto: true, model: "" };

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
			// streamSimple is the provider-neutral path for nested calls. `reasoning` is
			// deliberately omitted: pi's runtime treats a missing value as "off"
			// (options?.reasoning ?? "off"), and the option type does not accept "off".
			// cacheRetention: "none" keeps a one-off naming call out of the prompt cache,
			// matching what pi does for its own compaction summaries.
			const response = await ctx.modelRegistry
				.streamSimple(
					model,
					{ systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
					{ maxTokens: NAME_MAX_TOKENS, temperature: 0.2, cacheRetention: "none" },
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
		description: "Rename this session from the conversation (/rename [name|on|off|model <provider/id>])",
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

			// /rename model [provider/id|default] — which model does the naming.
			if (keyword === "model") {
				const pattern = rest.join(" ").trim();
				if (!pattern) {
					const model = pickModel(ctx);
					ctx.ui.notify(
						model
							? `pi-rename: naming model is ${config.model ? "(configured) " : "(session) "}${model.provider}/${model.id}`
							: "pi-rename: no model available",
						"info",
					);
					return;
				}
				config.model = pattern === "default" || pattern === "clear" ? "" : pattern;
				saveConfig(config);
				ctx.ui.notify(
					config.model ? `pi-rename: naming model → ${config.model}` : "pi-rename: naming model → session model",
					"info",
				);
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
