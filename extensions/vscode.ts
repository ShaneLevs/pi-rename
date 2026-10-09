/**
 * VS Code tab-title settings — make the terminal tab follow shell-reported
 * titles (i.e. pi's OSC sequences) on platforms whose default tab template
 * ignores them (notably Windows).
 *
 * What this module does, and nothing else:
 *   - locate the user-level settings.json (%APPDATA%\Code\User\settings.json
 *     on Windows, ~/Library/Application Support/Code/User/... on macOS,
 *     ~/.config/Code/User/... on Linux; Insiders / VSCodium variants probed
 *     as fallbacks);
 *   - if that file exists and `terminal.integrated.tabs.title` is not already
 *     "${sequence}", set it to "${sequence}", preserving every other setting.
 *
 * settings.json is JSONC (comments + trailing commas), so edits go through a
 * tiny JSONC normalizer instead of naive JSON.parse: comments and trailing
 * commas are stripped in memory before parsing; the file is written back as
 * tab-indented JSON (VS Code's own formatting convention, kept stable so
 * diffs stay small). A JSON5-style full editor is out of scope — if the file
 * cannot be parsed or written, the patch reports failure and leaves the file
 * untouched.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const TITLE_TEMPLATE = "${sequence}";
export const TITLE_SETTING = "terminal.integrated.tabs.title";

/** JSONC text with comments and trailing commas stripped. Strings survive verbatim. */
export function stripJsonc(text: string): string {
	let out = "";
	let index = 0;
	// "in string" | "in line comment" | "in block comment" | plain
	let mode: "code" | "line" | "block" | "string" = "code";
	while (index < text.length) {
		const char = text[index];
		const next = text[index + 1];
		if (mode === "code") {
			if (char === '"') {
				mode = "string";
				out += char;
			} else if (char === "/" && next === "/") {
				mode = "line";
				index += 1;
			} else if (char === "/" && next === "*") {
				mode = "block";
				index += 1;
			} else {
				out += char;
			}
		} else if (mode === "string") {
			// A backslash escapes the next character (\" \\ \u...); keep both.
			if (char === "\\") {
				out += char + (next ?? "");
				index += 1;
			} else if (char === '"') {
				mode = "code";
				out += char;
			} else {
				out += char;
			}
		} else if (mode === "line") {
			// Line comments end at the newline, which we keep for line numbering.
			if (char === "\n") {
				mode = "code";
				out += char;
			}
		} else {
			// Block comment: keep newlines, drop everything else until */.
			if (char === "*" && next === "/") {
				mode = "code";
				index += 1;
			} else if (char === "\n") {
				out += char;
			}
		}
		index += 1;
	}
	// Trailing commas: "a": 1,} → "a": 1}. Outside strings is guaranteed here.
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Tab-indented JSON — matches what VS Code itself writes to settings.json. */
export function stringifySettings(settings: unknown): string {
	return `${JSON.stringify(settings, null, "\t")}\n`;
}

/** Parse JSONC settings text; undefined when empty or not an object. */
function parseSettings(text: string): Record<string, unknown> | undefined {
	const stripped = stripJsonc(text).trim();
	if (!stripped) return undefined;
	try {
		const parsed: unknown = JSON.parse(stripped);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Caller reports the failure.
	}
	return undefined;
}

/** Test seams: the tests run on macOS/Linux but must be able to fake win32. */
let platformOverride: NodeJS.Platform | undefined;
let pathOverride: string[] | undefined;

export function setPlatformOverride(platform: NodeJS.Platform | undefined): void {
	platformOverride = platform;
}

/** The platform the patch logic should assume (overridable in tests). */
export function currentPlatform(): NodeJS.Platform {
	return platformOverride ?? process.platform;
}

export function setVscodePathsOverride(paths: string[] | undefined): void {
	pathOverride = paths;
}

/** Candidate user settings.json paths, most likely first. */
export function vscodeSettingsPaths(env: NodeJS.ProcessEnv = process.env): string[] {
	if (pathOverride) return pathOverride;
	const user = env.USERPROFILE || homedir();
	if (currentPlatform() === "win32") {
		// Windows: %APPDATA%\<flavor>\User\settings.json (APPDATA defaults to
		// %USERPROFILE%\AppData\Roaming, the path pi-rename's README documents).
		// Path separators are joined by hand so the result is correct even when
		// the code runs on a POSIX host (tests, WSL-style cross-checks).
		const base = env.APPDATA || `${user}\\AppData\\Roaming`;
		return ["Code", "Code - Insiders", "VSCodium"].map((dir) => `${base}\\${dir}\\User\\settings.json`);
	}
	if (currentPlatform() === "darwin") {
		const base = env.APPDATA || join(homedir(), "Library", "Application Support");
		return ["Code", "Code - Insiders", "VSCodium"].map((dir) => join(base, dir, "User", "settings.json"));
	}
	const configBase = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return ["Code", "Code - Insiders", "VSCodium"].map((dir) => join(configBase, dir, "User", "settings.json"));
}

export interface VscodePatchResult {
	/** applied — setting written; skip — already correct; missing — no VS Code settings file; failed — unreadable/unwritable/unparseable. */
	status: "applied" | "skip" | "missing" | "failed";
	/** The settings file that was inspected (the first existing candidate), if any. */
	path?: string;
	/** Human-readable detail, ready for a notify(). */
	message: string;
}

/**
 * Ensure `terminal.integrated.tabs.title` is "${sequence}" in the first
 * existing user settings.json. Never touches a file it cannot parse; never
 * reports failure when VS Code simply is not installed.
 */
export function ensureSequenceTitle(paths: string[] = vscodeSettingsPaths()): VscodePatchResult {
	const existing = paths.filter((path) => existsSync(path));
	if (existing.length === 0) {
		return { status: "missing", message: "pi-rename: no VS Code settings.json found; skipping the tab-title patch" };
	}
	const path = existing[0];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			status: "failed",
			path,
			message: `pi-rename: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	const settings = parseSettings(text);
	if (!settings) {
		return { status: "failed", path, message: `pi-rename: ${path} is not valid JSONC; not touching it` };
	}
	if (settings[TITLE_SETTING] === TITLE_TEMPLATE) {
		return { status: "skip", path, message: `pi-rename: ${TITLE_SETTING} is already "${TITLE_TEMPLATE}"` };
	}
	settings[TITLE_SETTING] = TITLE_TEMPLATE;
	try {
		// Write-then-rename so a crash mid-write cannot truncate the user's settings.
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, stringifySettings(settings), "utf8");
		renameSync(tmp, path);
	} catch (error) {
		return {
			status: "failed",
			path,
			message: `pi-rename: cannot write ${path} (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	return {
		status: "applied",
		path,
		message: `pi-rename: set "${TITLE_SETTING}": "${TITLE_TEMPLATE}" in ${path} (takes effect in a new terminal tab)`,
	};
}

/** Test seam: run the patch in a sandbox by pointing every candidate at a temp dir. */
export function patchForTesting(baseDir: string, flavor = "Code"): string {
	const dir = join(baseDir, flavor, "User");
	mkdirSync(dir, { recursive: true });
	return join(dir, "settings.json");
}
