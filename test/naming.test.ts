import { describe, expect, test } from "bun:test";
import {
	buildNameRequest,
	buildTranscriptDigest,
	collectTurns,
	countUnits,
	DIGEST_BUDGET,
	detectNameLanguage,
	extractText,
	fallbackName,
	limitUnits,
	MAX_NAME_UNITS,
	recentTurns,
	RECENT_TURNS,
	sanitizeLiteralName,
	sanitizeName,
	selectDigestTurns,
} from "../extensions/naming.ts";

describe("extractText / collectTurns", () => {
	test("flattens string and block content", () => {
		expect(extractText("hello")).toBe("hello");
		expect(extractText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a b");
		expect(extractText(undefined)).toBe("");
	});

	test("groups entries into user/assistant turns", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "第一条" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "回答一" }] } },
			{ type: "message", message: { role: "toolResult", content: "工具输出" } },
			{ type: "message", message: { role: "user", content: "第二条" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "回答二" }] } },
		];
		expect(collectTurns(entries)).toEqual([
			{ user: "第一条", assistant: "回答一" },
			{ user: "第二条", assistant: "回答二" },
		]);
	});

	test("keeps only the last assistant text block of a turn", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "问题" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "我先读一下文件" }] } },
			{ type: "message", message: { role: "toolResult", content: "文件内容" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "私密思考" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "中间说明" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "最终答案" }] } },
		];
		expect(collectTurns(entries)).toEqual([{ user: "问题", assistant: "最终答案" }]);
	});

	test("skips user entries without text and ignores non-message entries", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "image" }] } },
			{ type: "custom", customType: "pi-rename" },
			{ type: "message", message: { role: "assistant", content: "没有前文的答案" } },
			{ type: "message", message: { role: "user", content: "问题" } },
		];
		expect(collectTurns(entries)).toEqual([{ user: "问题", assistant: "" }]);
	});
});

describe("recentTurns", () => {
	const turns = Array.from({ length: 8 }, (_, index) => ({ user: `u${index}`, assistant: `a${index}` }));

	test("defaults to the last 5 turns", () => {
		expect(RECENT_TURNS).toBe(5);
		expect(recentTurns(turns).map((turn) => turn.user)).toEqual(["u3", "u4", "u5", "u6", "u7"]);
	});

	test("returns everything when fewer than N", () => {
		expect(recentTurns(turns.slice(0, 2))).toHaveLength(2);
	});

	test("falls back to the newest turn for nonsense counts", () => {
		expect(recentTurns(turns, 0).map((turn) => turn.user)).toEqual(["u7"]);
		expect(recentTurns(turns, Number.NaN).map((turn) => turn.user)).toEqual(["u7"]);
	});
});

describe("countUnits / limitUnits", () => {
	test("one CJK character is one unit", () => {
		// 给/会/话/自/动/命/名 = 7 characters, so 7 units.
		expect(countUnits("给会话自动命名")).toBe(7);
		expect(countUnits("これは")).toBe(3);
		expect(countUnits("리네임")).toBe(3);
	});

	test("one alphabetic word is one unit", () => {
		expect(countUnits("rename the session title")).toBe(4);
		expect(countUnits("don't repeat-not-a-subcommand")).toBe(2);
		expect(countUnits("переименовать сессию")).toBe(2);
	});

	test("mixed scripts count separately", () => {
		expect(countUnits("pi插件")).toBe(3);
		expect(countUnits("给 pi-rename 加自动命名和 VS Code 标题同步功能")).toBe(16);
	});

	test("spaces and punctuation are free", () => {
		expect(countUnits("a, b! c.")).toBe(3);
		expect(countUnits("   ")).toBe(0);
	});

	test("the default ceiling is 15 units", () => {
		expect(MAX_NAME_UNITS).toBe(15);
	});

	test("cuts on a unit boundary with no ellipsis", () => {
		expect(limitUnits("这是一个非常长的中文标题名字用来测试截断")).toBe("这是一个非常长的中文标题名字用");
		expect(limitUnits("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen")).toBe(
			"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
		);
		// A CJK tail glued to a Latin word is still split correctly.
		expect(limitUnits("pi插件会话标题同步终端标签栏的名字要很长很长", 15)).toBe("pi插件会话标题同步终端标签栏的");
	});

	test("keeps short text intact", () => {
		expect(limitUnits("短标题")).toBe("短标题");
		expect(limitUnits("", 15)).toBe("");
	});
});

describe("detectNameLanguage", () => {
	test("follows the user's script", () => {
		expect(detectNameLanguage([{ user: "帮我给会话自动命名", assistant: "" }])).toContain("Chinese");
		expect(detectNameLanguage([{ user: "rename my session automatically", assistant: "" }])).toBe("English");
		expect(detectNameLanguage([{ user: "セッションを自動でリネーム", assistant: "" }])).toBe("Japanese");
		expect(detectNameLanguage([{ user: "세션을 자동으로 이름 붙이기", assistant: "" }])).toBe("Korean");
		expect(detectNameLanguage([{ user: "переименовать сессию автоматически", assistant: "" }])).toBe("Russian");
	});

	test("a mostly Chinese session with identifiers stays Chinese", () => {
		const language = detectNameLanguage([{ user: "帮我改 pi-rename 的 rename 命令和 VSCode 标题", assistant: "" }]);
		expect(language).toContain("Chinese");
	});

	test("no letters leaves the choice to the model", () => {
		expect(detectNameLanguage([{ user: "1234 + 5678 = ?", assistant: "" }])).toContain("user wrote in");
	});
});

describe("sanitizeName", () => {
	test("takes the first line and strips decoration", () => {
		expect(sanitizeName('"重构 Auth 模块"\n这个标题说明为什么这样起名字')).toBe("重构 Auth 模块");
		expect(sanitizeName("```\nFix login\n```")).toBe("Fix login");
		expect(sanitizeName("- Title: Session cleanup.")).toBe("Session cleanup");
		expect(sanitizeName("标题：终端标题功能")).toBe("终端标题功能");
		expect(sanitizeName("**Rename flow**")).toBe("Rename flow");
	});

	test("caps at 15 units", () => {
		const name = sanitizeName("这是一个非常长的中文标题名字用来测试十五个字的截断行为");
		expect(countUnits(name)).toBeLessThanOrEqual(15);
		expect(name).toBe("这是一个非常长的中文标题名字用");
	});

	test("rejects names without any word character", () => {
		expect(sanitizeName("...---!!!")).toBe("");
		expect(sanitizeName("")).toBe("");
	});

	test("removes control characters", () => {
		expect(sanitizeName("oops\u0007\u001b]0;inject\u0007")).toBe("oops ]0;inject");
	});
});

describe("fallbackName", () => {
	test("uses the first line of the prompt, within the unit limit", () => {
		expect(fallbackName("给会话重命名\n第二行要求")).toBe("给会话重命名");
		expect(countUnits(fallbackName("一二三四五六七八九十一二三四五六七八九十一二三四五"))).toBe(15);
	});
});

describe("buildNameRequest", () => {
	test("states the unit limit and the detected language", () => {
		const { systemPrompt, prompt, language } = buildNameRequest([{ user: "帮我给会话自动命名", assistant: "好的" }]);
		expect(language).toContain("Chinese");
		expect(systemPrompt).toContain("ONLY the name");
		expect(systemPrompt).toContain("at most 15 units");
		expect(systemPrompt).toContain(`Write the name in: ${language}`);
		// A real failure: a session was named 一句话回答 because the model read the
		// user's answer-style instruction as the topic.
		expect(systemPrompt).toContain("Ignore instructions about format or length");
		expect(prompt).toContain("in Chinese (Simplified unless the user writes Traditional), within 15 units");
		expect(prompt).toContain("USER: 帮我给会话自动命名");
		expect(prompt).toContain("ASSISTANT: 好的");
		expect(prompt).toContain("1 turn");
	});

	test("sends user prompts in full and only the final answer body", () => {
		const longUser = "很长的用户问题".repeat(50);
		const { prompt } = buildNameRequest([
			{ user: "第一轮的长问题", assistant: "过程说明" },
			{ user: longUser, assistant: "最终答案正文" },
		]);
		expect(prompt).toContain(longUser);
		expect(prompt).toContain("USER: 第一轮的长问题");
		expect(prompt).toContain("ASSISTANT: 最终答案正文");
		expect(prompt).toContain("2 turns");
	});

	test("keeps the whole window by clipping answers before dropping turns", () => {
		// Long answers used to collapse a 5-turn window down to one turn.
		const fat = Array.from({ length: 12 }, (_, index) => ({
			user: `turn-${index} 的问题`,
			assistant: "很长的回答细节".repeat(300),
		}));
		const window = recentTurns(fat);
		const selected = selectDigestTurns(window);
		expect(selected.length).toBe(RECENT_TURNS);
		const digest = buildTranscriptDigest(window);
		expect(digest).toContain("turn-7 ");
		expect(digest).toContain("turn-11 ");
		// Every answer shares one cap and the whole window survives.
		for (const turn of selected) expect(turn.assistant.length).toBeLessThanOrEqual(3001);
		expect(buildNameRequest(window).prompt).toContain("5 turns");
	});

	test("drops whole turns and tells the truth about it when users are unclippable", () => {
		const turns = Array.from({ length: 6 }, (_, index) => ({
			user: `turn-${index} ${"很长的问题".repeat(1000)}`,
			assistant: "短答案",
		}));
		const window = recentTurns(turns);
		const selected = selectDigestTurns(window);
		expect(selected.length).toBeLessThan(window.length);
		expect(selected.at(-1)?.user).toContain("turn-5");
		// The header reports the turns actually sent, not the requested window.
		const count = selected.length === 1 ? "1 turn" : `${selected.length} turns`;
		expect(buildNameRequest(window).prompt).toContain(`(${count})`);
		expect(buildNameRequest(window).prompt).not.toContain("(5 turns)");
	});

	test("never clips user prompts even when answers get trimmed", () => {
		const longUser = "这个问题特别长".repeat(200);
		const window = recentTurns([
			{ user: longUser, assistant: "回答".repeat(2000) },
			{ user: "第二轮", assistant: "第二轮回答".repeat(2000) },
		]);
		const digest = buildTranscriptDigest(window);
		expect(digest).toContain(longUser);
		expect(digest).toContain(" …");
	});
});

describe("sanitizeLiteralName", () => {
	test("keeps what the user typed, only fixing whitespace and control chars", () => {
		expect(sanitizeLiteralName("  My   Session: Phase 2  ")).toBe("My Session: Phase 2");
		expect(sanitizeLiteralName("这是一个远远超过十五个字的会话名字不应该被截断因为是我自己打的")).toBe(
			"这是一个远远超过十五个字的会话名字不应该被截断因为是我自己打的",
		);
		expect(sanitizeLiteralName("行\n新行")).toBe("行 新行");
		expect(sanitizeLiteralName("\u0007")).toBe("");
	});
});
