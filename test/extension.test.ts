import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import renameExtension from "../extensions/index.ts";

interface HarnessOptions {
	name?: string;
	entries?: unknown[];
	/** Text the fake model returns. */
	modelReply?: string;
	/** Raw content blocks the fake model returns (overrides modelReply). */
	modelBlocks?: unknown[];
	stopReason?: string;
	modelError?: string;
	mode?: "tui" | "rpc" | "print";
	config?: Record<string, unknown>;
}

/** Temp config dir, created per test by beforeEach below. */
let dir = "";

function createHarness(options: HarnessOptions = {}) {
	// The extension reads config.json while it loads, so write it before that.
	if (options.config) writeFileSync(join(dir, "config.json"), JSON.stringify(options.config), "utf8");
	const events = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();

	let sessionName = options.name;
	const entries: unknown[] = options.entries ?? [];
	const calls: { systemPrompt: string; prompt: string; options: Record<string, unknown> }[] = [];
	const titles: string[] = [];
	const notices: { message: string; level: string }[] = [];
	const appended: { customType: string; data: unknown }[] = [];

	const model = {
		id: "test-model",
		name: "Test Model",
		provider: "test",
		api: "test",
		reasoning: false,
		input: ["text"],
		cost: {},
		contextWindow: 200000,
		maxTokens: 8192,
		baseUrl: "http://localhost",
	};
	const otherModel = { ...model, id: "other-model", name: "Other Model", provider: "other" };

	const ctx: any = {
		mode: options.mode ?? "rpc",
		hasUI: true,
		cwd: "/repo/HTML",
		ui: {
			setTitle: (title: string) => titles.push(title),
			notify: (message: string, level = "info") => notices.push({ message, level }),
		},
		sessionManager: {
			getCwd: () => "/repo/HTML",
			getBranch: () => entries,
			getSessionName: () => sessionName,
		},
		modelRegistry: {
			getAvailable: () => [model, otherModel],
			// The extension uses the provider-neutral streamSimple(...).result() path.
			streamSimple: (_model: unknown, context: any, streamOptions?: any) => {
				calls.push({
					systemPrompt: context.systemPrompt,
					prompt: context.messages[0].content,
					options: streamOptions ?? {},
				});
				return {
					result: async () => {
						if (options.modelError) throw new Error(options.modelError);
						return {
							role: "assistant",
							content:
								options.modelBlocks ?? [{ type: "text", text: options.modelReply ?? "生成的标题" }],
							stopReason: options.stopReason ?? "stop",
						};
					},
				};
			},
		},
		model,
		signal: undefined,
	};

	const pi: any = {
		on: (event: string, handler: any) => {
			events.set(event, handler);
			return () => events.delete(event);
		},
		registerCommand: (name: string, options: any) => commands.set(name, options),
		setSessionName: (name: string) => {
			sessionName = name && name.trim() ? name.trim() : undefined;
		},
		getSessionName: () => sessionName,
		appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
	};

	renameExtension(pi);

	return {
		ctx,
		titles,
		notices,
		appended,
		calls,
		entries,
		getName: () => sessionName,
		emit: (event: string, payload: any = {}) => events.get(event)?.({ type: event, ...payload }, ctx),
		run: (args: string) => commands.get("rename")!.handler(args, ctx),
		command: () => commands.get("rename"),
		/** Simulates pi's own `/name`: the name changes, then the event fires. */
		setNameThroughPi: (name: string) => pi.setSessionName(name),
	};
}

/** One finished exchange: a user prompt plus its answer. */
function firstExchange(user = "帮我给会话自动命名", assistant = "好的，我来实现。") {
	return [
		{ type: "message", message: { role: "user", content: user } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: assistant }] } },
	];
}

/** Auto-renaming is fire-and-forget; let the detached promise chain settle. */
async function flush() {
	for (let index = 0; index < 8; index++) await new Promise((resolve) => setTimeout(resolve, 1));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-rename-"));
	mkdirSync(dir, { recursive: true });
	process.env.PI_RENAME_CONFIG_DIR = dir;
});
afterEach(() => {
	delete process.env.PI_RENAME_CONFIG_DIR;
	rmSync(dir, { recursive: true, force: true });
});

describe("auto-rename", () => {
	test("renames the session after the first settled run and titles the terminal", async () => {
		const h = createHarness({ entries: firstExchange(), modelReply: "会话自动命名" });
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.getName()).toBe("会话自动命名");
		expect(h.titles).toContain("会话自动命名");
		expect(h.appended[0]?.customType).toBe("pi-rename");
		expect(h.calls[0]?.prompt).toContain("帮我给会话自动命名");
	});

	test("does not overwrite a name the user already chose", async () => {
		const h = createHarness({ name: "重要会话", entries: firstExchange() });
		await h.emit("session_start", { reason: "resume" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.getName()).toBe("重要会话");
		expect(h.calls).toHaveLength(0);
		// Still re-applies the title for the resumed session.
		expect(h.titles).toContain("重要会话");
	});

	test("skips an aborted run", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: true });
		await flush();
		expect(h.calls).toHaveLength(0);
		expect(h.getName()).toBeUndefined();
	});

	test("runs only once per session, even across later turns", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		h.entries.push({ type: "message", message: { role: "user", content: "再来一轮" } });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.calls).toHaveLength(1);
	});

	test("treats a persisted attempt marker as done (reload/resume)", async () => {
		const h = createHarness({
			entries: [...firstExchange(), { type: "custom", customType: "pi-rename", data: { autoRenamed: true } }],
		});
		await h.emit("session_start", { reason: "resume" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.calls).toHaveLength(0);
	});

	test("/rename off disables it and persists to the config file", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.run("off");
		const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
		expect(saved.auto).toBe(false);
		// A fresh harness re-reads that file.
		const h2 = createHarness({ entries: firstExchange() });
		await h2.emit("session_start", { reason: "new" });
		await h2.emit("agent_settled", { aborted: false });
		await flush();
		expect(h2.calls).toHaveLength(0);
		void h;
	});

	test("/rename on turns it back on", async () => {
		const h = createHarness({ entries: firstExchange(), config: { auto: false } });
		await h.run("on");
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).auto).toBe(true);
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.calls).toHaveLength(1);
	});

	test("skips non-interactive modes", async () => {
		const h = createHarness({ entries: firstExchange(), mode: "print" });
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.calls).toHaveLength(0);
	});

	test("falls back to the prompt when the naming call fails", async () => {
		const h = createHarness({
			entries: firstExchange("修复终端标题不生效的问题", "ignore"),
			modelError: "no auth",
		});
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.getName()).toBe("修复终端标题不生效的问题");
		expect(h.notices.some((n) => n.level === "warning")).toBe(true);
	});

	test("requests no prompt cache and a roomy output cap", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.calls[0]?.options).toMatchObject({ cacheRetention: "none", temperature: 0.2 });
		expect(h.calls[0]?.options.maxTokens).toBeGreaterThanOrEqual(256);
		// reasoning stays undefined so pi's runtime treats the call as thinking-off.
		expect(h.calls[0]?.options.reasoning).toBeUndefined();
	});

	test("warns and falls back when the model returns only thinking", async () => {
		const h = createHarness({
			entries: firstExchange("给会话起个短名字", "ignore"),
			modelBlocks: [{ type: "thinking", thinking: "让我想想这个会话的主题是什么呢" }],
			stopReason: "length",
		});
		await h.emit("session_start", { reason: "new" });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.getName()).toBe("给会话起个短名字");
		expect(h.notices.some((n) => n.message.includes("no usable name") && n.message.includes("length"))).toBe(true);
	});

	test("renames on the first settle even without a prior session_start", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.emit("agent_settled", { aborted: false });
		await flush();
		expect(h.getName()).toBe("生成的标题");
	});
});

describe("/rename", () => {
	test("is registered as the only command", () => {
		const h = createHarness();
		expect(h.command()?.description).toContain("Rename this session");
	});

	test("takes a literal name", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.run("Pi 重命名扩展 v2");
		expect(h.getName()).toBe("Pi 重命名扩展 v2");
		expect(h.titles.at(-1)).toBe("Pi 重命名扩展 v2");
		expect(h.calls).toHaveLength(0);
	});

	test("whitespace-only args behave like a bare /rename", async () => {
		const h = createHarness({ name: "旧名字", entries: firstExchange(), modelReply: "新名字" });
		await h.run("   ");
		expect(h.calls).toHaveLength(1);
		expect(h.getName()).toBe("新名字");
	});
});

describe("/rename (model-generated)", () => {
	test("generates from the last 5 turns and overwrites the current name", async () => {
		const entries: unknown[] = [];
		for (let index = 1; index <= 8; index++) {
			entries.push({ type: "message", message: { role: "user", content: `第${index}个问题` } });
			entries.push({ type: "message", message: { role: "assistant", content: `回答${index}` } });
		}
		const h = createHarness({ name: "旧名字", entries, modelReply: "终端标题与重命名" });
		await h.run("");
		expect(h.getName()).toBe("终端标题与重命名");
		expect(h.calls[0]?.prompt).toContain("5 turns");
		// Turns 1-3 fall outside the 5-turn window.
		expect(h.calls[0]?.prompt).not.toContain("第1个问题");
		expect(h.calls[0]?.prompt).toContain("第4个问题");
		expect(h.titles.at(-1)).toBe("终端标题与重命名");
	});

	test("warns when there is nothing to rename from", async () => {
		const h = createHarness({ entries: [] });
		await h.run("");
		expect(h.notices.at(-1)?.message).toContain("nothing to rename yet");
		expect(h.getName()).toBeUndefined();
	});
});

describe("/rename model", () => {
	test("sets and persists the naming model", async () => {
		const h = createHarness({ name: "会话", entries: firstExchange() });
		await h.run("model other/other-model");
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).model).toBe("other/other-model");
		await h.run("");
		expect(h.calls.length).toBe(1);
	});

	test("reports the effective model with no argument", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.run("model");
		expect(h.notices.at(-1)?.message).toContain("(session) test/test-model");
		await h.run("model other/other-model");
		await h.run("model");
		expect(h.notices.at(-1)?.message).toContain("(configured) other/other-model");
	});

	test("default clears the override", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.run("model other/other-model");
		await h.run("model default");
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).model).toBe("");
	});

	test("warns when the pattern matches nothing but still renames", async () => {
		const h = createHarness({ entries: firstExchange(), modelReply: "回落会话模型" });
		await h.run("model no/such-model");
		await h.run("");
		expect(h.notices.some((n) => n.message.includes("no model matches"))).toBe(true);
		expect(h.getName()).toBe("回落会话模型");
	});
});

describe("terminal title", () => {
	test("is the session name, verbatim except for control characters", async () => {
		const h = createHarness({ entries: firstExchange() });
		h.setNameThroughPi("含\u0007控制符的名字");
		await h.emit("session_info_changed", { name: "含\u0007控制符的名字" });
		expect(h.titles.at(-1)).toBe("含 控制符的名字");
	});

	test("re-applies the title after pi changes the name", async () => {
		const h = createHarness({ entries: firstExchange() });
		h.setNameThroughPi("外部改名");
		await h.emit("session_info_changed", { name: "外部改名" });
		expect(h.getName()).toBe("外部改名");
		expect(h.titles.at(-1)).toBe("外部改名");
	});

	test("leaves the title alone while the session has no name", async () => {
		const h = createHarness({ entries: firstExchange() });
		await h.emit("session_start", { reason: "new" });
		expect(h.titles).toHaveLength(0);
	});
});
