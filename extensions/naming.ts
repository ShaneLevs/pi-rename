/**
 * pi-rename — pure helpers (no pi imports, so they are unit-testable).
 *
 * Naming contract:
 *   - every user prompt of the window is handed over in full;
 *   - each turn contributes only its LAST assistant text block — the final
 *     answer body, not the intermediate "let me read this file" chatter;
 *   - the name is capped in units: one CJK character = 1 unit, one word of an
 *     alphabetic language = 1 unit, spaces and punctuation are free;
 *   - the name's language follows the user's own messages.
 */

/** Minimal shape of a session entry we care about. */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
	};
}

export interface Turn {
	user: string;
	assistant: string;
}

/** Name ceiling: 15 Chinese characters, or 15 English words. */
export const MAX_NAME_UNITS = 15;

/** How many recent turns a rename looks at. */
export const RECENT_TURNS = 5;

/** Characters that must never reach a terminal title. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * One counted unit = one CJK / Kana / Hangul character, or one word made of
 * non-CJK letters and digits. Ranges are explicit so Bun and Node agree.
 */
const CJK_UNIT = "[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]";
// A word is a run of letters/digits that are NOT CJK, so "pi插件" counts as
// pi(1) + 插(1) + 件(1) instead of one glued token. Apostrophes and hyphens
// bind: "don't" and "not-a-subcommand" are one unit each.
const LATIN_CHAR = `(?!${CJK_UNIT})[\\p{L}\\p{N}]`;
const WORD_UNIT = `${LATIN_CHAR}(?:${LATIN_CHAR}|['\u2019_-])*`;
const TOKEN_RE = new RegExp(`${CJK_UNIT}|${WORD_UNIT}|[\\s\\S]`, "gu");
const WORD_RE = new RegExp(`^${WORD_UNIT}$`, "u");
const CJK_RE = new RegExp(`^${CJK_UNIT}$`, "u");

/**
 * Flatten a message payload into plain text.
 * Handles string content and `{ type: "text", text }` blocks; ignores thinking,
 * tool-call and image blocks.
 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join(" ");
}

/**
 * Group session entries into user/assistant turns.
 * A turn starts at a user message with text; its assistant side keeps only the
 * last non-empty assistant text block, i.e. the answer after tool chatter.
 */
export function collectTurns(entries: readonly EntryLike[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | undefined;
	const push = () => {
		if (current) turns.push(current);
	};
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		const text = extractText(entry.message.content).trim();
		if (role === "user") {
			if (!text) continue;
			push();
			current = { user: text, assistant: "" };
		} else if (role === "assistant") {
			// Last block wins: earlier ones are process chatter, not the answer.
			if (!current || !text) continue;
			current.assistant = text;
		}
	}
	push();
	return turns;
}

/** Last `count` turns that actually have a user prompt. */
export function recentTurns(turns: readonly Turn[], count: number = RECENT_TURNS): Turn[] {
	const usable = turns.filter((turn) => turn.user.length > 0);
	if (!Number.isFinite(count) || count <= 0) return usable.slice(-1);
	return usable.slice(-count);
}

/** Count a string's length in units (CJK character = 1, word = 1, punctuation free). */
export function countUnits(text: string): number {
	let units = 0;
	for (const token of (text ?? "").matchAll(TOKEN_RE)) {
		const value = token[0]!;
		if (CJK_RE.test(value) || WORD_RE.test(value)) units++;
	}
	return units;
}

/**
 * Cut a string to at most `maxUnits` units on a unit boundary and drop the
 * dangling separator left behind. A title carries no ellipsis, so the tail is
 * simply removed.
 */
export function limitUnits(text: string, maxUnits: number = MAX_NAME_UNITS): string {
	const source = text ?? "";
	if (!Number.isFinite(maxUnits) || maxUnits <= 0) return "";
	let units = 0;
	let out = "";
	for (const token of source.matchAll(TOKEN_RE)) {
		const value = token[0]!;
		const isUnit = CJK_RE.test(value) || WORD_RE.test(value);
		if (isUnit && units === maxUnits) break;
		if (isUnit) units++;
		out += value;
	}
	return out.replace(/[\s\p{P}]+$/u, "").trim();
}

/** Collapse whitespace so a whole message stays on one digest line. */
function oneLine(text: string): string {
	return (text ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * Guess the language the name should be written in, from the user side of the
 * conversation — the assistant's language is not evidence of the user's.
 */
export function detectNameLanguage(turns: readonly Turn[]): string {
	const userText = turns.map((turn) => turn.user).join(" ");
	const han = (userText.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
	const kana = (userText.match(/[\u3040-\u30ff]/gu) ?? []).length;
	const hangul = (userText.match(/[\uac00-\ud7af]/gu) ?? []).length;
	const cyrillic = (userText.match(/[\u0400-\u04ff]/gu) ?? []).length;
	const latin = (userText.match(/[A-Za-z]/g) ?? []).length;
	const total = han + kana + hangul + cyrillic + latin;
	if (total === 0) return "the language the user wrote in";
	const share = (count: number) => count / total;
	if (share(kana) >= 0.2 && kana >= han) return "Japanese";
	if (share(hangul) >= 0.2) return "Korean";
	if (share(cyrillic) >= 0.2 && cyrillic >= latin) return "Russian";
	if (share(han) >= 0.2) return "Chinese (Simplified unless the user writes Traditional)";
	if (share(latin) >= 0.8) return "English";
	return "the dominant language of the user's messages";
}

/**
 * The digest handed to the model. User prompts are never truncated; assistant
 * answers are clipped in stages and whole turns are dropped only as a last
 * resort, so a rename normally sees the full recent window.
 */
export const DIGEST_BUDGET = 12000;

/**
 * Assistant-answer lengths tried, most content first. A user message is never
 * shortened, so when the window overflows we trim answers before dropping a
 * turn: losing a whole turn costs more context than losing an answer's tail.
 */
const ASSISTANT_CAPS = [Number.POSITIVE_INFINITY, 3000, 1200, 400];

function clipChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars).trimEnd()} …`;
}

/** One turn's digest lines. */
function digestChunk(turn: Turn): string {
	const lines = [`USER: ${oneLine(turn.user)}`];
	if (turn.assistant) lines.push(`ASSISTANT: ${oneLine(turn.assistant)}`);
	return lines.join("\n");
}

/**
 * The turns that actually make it into the digest, oldest dropped first, with
 * assistant answers clipped only as much as needed to keep the whole window.
 * The newest turn is always kept even if it alone exceeds the budget.
 */
export function selectDigestTurns(turns: readonly Turn[], budget = DIGEST_BUDGET): Turn[] {
	let best: Turn[] = [];
	for (const cap of ASSISTANT_CAPS) {
		const prepared = turns.map((turn) => ({
			user: turn.user,
			assistant: Number.isFinite(cap) ? clipChars(oneLine(turn.assistant), cap) : turn.assistant,
		}));
		const kept: Turn[] = [];
		let used = 0;
		for (let index = prepared.length - 1; index >= 0; index--) {
			const chunk = digestChunk(prepared[index]!);
			if (kept.length > 0 && used + chunk.length + 1 > budget) break;
			kept.unshift(prepared[index]!);
			used += chunk.length + 1;
		}
		// Every turn fits at this cap: the most content that still works.
		if (kept.length === turns.length) return kept;
		// More turns kept than any earlier cap (ties keep the larger cap).
		if (kept.length > best.length) best = kept;
	}
	return best;
}

/** Render turns already selected for the digest. */
function renderDigest(turns: readonly Turn[]): string {
	return turns.map(digestChunk).join("\n");
}

export function buildTranscriptDigest(turns: readonly Turn[], budget = DIGEST_BUDGET): string {
	return renderDigest(selectDigestTurns(turns, budget));
}

const NAME_LABEL_PREFIX =
	/^(?:proposed\s+)?(?:title|name|session\s+name|conversation\s+name|会话名(?:称)?|会话标题|标题|名称)\s*[:：\-—]\s*/i;

/**
 * Turn whatever the model answered into a usable session name.
 * Returns "" when nothing sensible is left, so callers can fall back.
 */
export function sanitizeName(raw: string, maxUnits: number = MAX_NAME_UNITS): string {
	// Fences first: a fenced answer puts ``` on its own line before the name.
	const unfenced = (raw ?? "").replace(/```[a-z]*/gi, " ");
	// First non-empty line only; models sometimes add a sentence after the name.
	const line = unfenced.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
	let name = oneLine(line);
	// Repeat, because decoration comes in layers: "- **Title: foo**".
	for (let pass = 0; pass < 3; pass++) {
		const before = name;
		name = name.replace(/^[#>\-*\u2022\s]+/, "").replace(/["'“‘‛`*_#\s]+$/g, "").trim();
		name = name.replace(NAME_LABEL_PREFIX, "").trim();
		name = name.replace(/^["'“‘‛`]+/, "").trim();
		if (name === before) break;
	}
	// A title never ends with sentence punctuation.
	name = name.replace(/[.,;:!?。，；：！？，、]+$/, "").trim();
	name = name.replace(/\s+/g, " ").trim();
	// A name that lost every word-like character is useless.
	if (!/[\p{L}\p{N}]/u.test(name)) return "";
	return limitUnits(name, maxUnits);
}

/** Name derived from the first user prompt when the model is unavailable. */
export function fallbackName(userText: string, maxUnits: number = MAX_NAME_UNITS): string {
	return sanitizeName(userText.split(/\r?\n/)[0] ?? "", maxUnits);
}

/**
 * Cleanup for a name the user typed literally after `/rename`: keep the words,
 * only remove what would break a terminal title. No length policy here — what
 * the user typed is what they asked for.
 */
export function sanitizeLiteralName(raw: string): string {
	return oneLine(raw ?? "");
}

/**
 * The exact system prompt handed to the naming model, with the unit limit and
 * the language resolved from the conversation itself.
 */
export function buildNameSystemPrompt(language: string): string {
	return [
		"You name AI coding-assistant sessions so a human can recognise the conversation from a terminal tab title alone.",
		"Rules:",
		"- Reply with ONLY the name, on a single line. No quotes, no markdown, no explanation, no trailing punctuation.",
		`- Length limit: at most ${MAX_NAME_UNITS} units, where one Chinese/Japanese/Korean character is one unit and one word of an alphabetic language is one unit. Aim well under the limit — a tab title, not a summary sentence.`,
		`- Write the name in: ${language}. Judge this from the user's own messages, not from the assistant's.`,
		"- Prefer the concrete task or topic over generic words like 'question', 'help', 'chat', 'coding'.",
		"- Name what the conversation is ABOUT. Ignore instructions about format or length of the assistant's replies ('answer in one sentence', 'be brief') — those are not the topic.",
		"- Keep technical identifiers (file, tool, API names) as-is when they are the topic.",
	].join("\n");
}

/** The two strings the naming model actually sees. */
export function buildNameRequest(turns: readonly Turn[]): {
	systemPrompt: string;
	prompt: string;
	language: string;
} {
	const language = detectNameLanguage(turns);
	// Count what is really sent, not what the window asked for: an unusually fat
	// window can still lose its oldest turns.
	const selected = selectDigestTurns(turns);
	const digest = renderDigest(selected);
	const turnWord = selected.length === 1 ? "turn" : "turns";
	return {
		systemPrompt: buildNameSystemPrompt(language),
		language,
		prompt: `Name this conversation (${selected.length} ${turnWord}) in ${language}, within ${MAX_NAME_UNITS} units:

${digest}

Name:`,
	};
}
