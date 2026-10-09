import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureSequenceTitle,
	setVscodePathsOverride,
	stripJsonc,
	stringifySettings,
	TITLE_SETTING,
	TITLE_TEMPLATE,
	vscodeSettingsPaths,
} from "../extensions/vscode.ts";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-rename-vscode-"));
	setVscodePathsOverride(undefined);
});
afterEach(() => {
	setVscodePathsOverride(undefined);
	rmSync(dir, { recursive: true, force: true });
});

function settingsPath(flavor = "Code"): string {
	const flavorDir = join(dir, flavor, "User");
	mkdirSync(flavorDir, { recursive: true });
	return join(flavorDir, "settings.json");
}

/** Write a settings.json in the fake user dir and return its path. */
function writeSettings(content: string, flavor = "Code"): string {
	const path = settingsPath(flavor);
	writeFileSync(path, content, "utf8");
	return path;
}

describe("stripJsonc", () => {
	test("strips line comments but keeps strings intact", () => {
		expect(stripJsonc('{\n// comment\n"a": "http://x" // tail\n}')).toBe('{\n\n"a": "http://x" \n}');
		expect(stripJsonc('"a//b"')).toBe('"a//b"');
	});

	test("strips block comments and keeps their newlines", () => {
		expect(stripJsonc('{\n/* multi\nline */"a": 1\n}')).toBe('{\n\n"a": 1\n}');
	});

	test("keeps escaped quotes inside strings", () => {
		expect(stripJsonc('{"a": "say \\"hi//\\"" }')).toBe('{"a": "say \\"hi//\\"" }');
	});

	test("removes trailing commas outside strings", () => {
		expect(stripJsonc('{"a": [1, 2,],}')).toBe('{"a": [1, 2]}');
		expect(stripJsonc('{"a": "ends with comma,"}')).toBe('{"a": "ends with comma,"}');
	});
});

function withWin32<T>(run: () => T): T {
	const saved = process.platform;
	Object.defineProperty(process, "platform", { value: "win32" });
	try {
		return run();
	} finally {
		Object.defineProperty(process, "platform", { value: saved });
	}
}

describe("vscodeSettingsPaths", () => {
	test("windows uses APPDATA flavor dirs", () => {
		const paths = withWin32(() =>
			vscodeSettingsPaths({
				USERPROFILE: "C:\\Users\\xiexy",
				APPDATA: "C:\\Users\\xiexy\\AppData\\Roaming",
			}),
		);
		expect(paths[0]).toBe("C:\\Users\\xiexy\\AppData\\Roaming\\Code\\User\\settings.json");
		expect(paths.some((p) => p.includes("Code - Insiders"))).toBe(true);
	});

	test("windows falls back to USERPROFILE when APPDATA is unset", () => {
		const paths = withWin32(() => vscodeSettingsPaths({ USERPROFILE: "C:\\Users\\x" }));
		expect(paths[0]).toBe("C:\\Users\\x\\AppData\\Roaming\\Code\\User\\settings.json");
	});

	test("macOS uses Application Support, Linux uses .config", () => {
		const mac = vscodeSettingsPaths({});
		expect(mac[0]).toContain("Application Support/Code/User/settings.json");
		expect(mac[0]).toContain(homedir());
	});
	test("linux honours XDG_CONFIG_HOME", () => {
		const saved = process.platform;
		Object.defineProperty(process, "platform", { value: "linux" });
		try {
			const linux = vscodeSettingsPaths({ XDG_CONFIG_HOME: "/xdg" });
			expect(linux[0]).toBe("/xdg/Code/User/settings.json");
		} finally {
			Object.defineProperty(process, "platform", { value: saved });
		}
	});
});

describe("ensureSequenceTitle", () => {
	test("no settings file anywhere → missing", () => {
		const result = ensureSequenceTitle([join(dir, "absent.json")]);
		expect(result.status).toBe("missing");
	});

	test("missing setting is added to valid JSONC with comments", () => {
		const path = writeSettings('{\n\t// editor font\n\t"editor.fontSize": 14,\n}');
		const result = ensureSequenceTitle([path]);
		expect(result.status).toBe("applied");
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved[TITLE_SETTING]).toBe(TITLE_TEMPLATE);
		expect(saved["editor.fontSize"]).toBe(14);
	});

	test("an existing different template is overwritten, other settings survive", () => {
		const path = writeSettings(JSON.stringify({ [TITLE_SETTING]: "${cwd}", "workbench.colorTheme": "Dark" }));
		const result = ensureSequenceTitle([path]);
		expect(result.status).toBe("applied");
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved[TITLE_SETTING]).toBe(TITLE_TEMPLATE);
		expect(saved["workbench.colorTheme"]).toBe("Dark");
	});

	test("already ${sequence} → skip and no rewrite", () => {
		const path = writeSettings(stringifySettings({ [TITLE_SETTING]: TITLE_TEMPLATE }));
		const before = readFileSync(path, "utf8");
		const result = ensureSequenceTitle([path]);
		expect(result.status).toBe("skip");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("unparseable file is left untouched", () => {
		const path = writeSettings("{ not json at all ][");
		const result = ensureSequenceTitle([path]);
		expect(result.status).toBe("failed");
		expect(readFileSync(path, "utf8")).toBe("{ not json at all ][");
	});

	test("first existing candidate wins", () => {
		const stable = writeSettings(stringifySettings({ [TITLE_SETTING]: TITLE_TEMPLATE }), "Code");
		const insiders = writeSettings("{}", "Code - Insiders");
		const result = ensureSequenceTitle([stable, insiders]);
		expect(result.status).toBe("skip");
		expect(result.path).toBe(stable);
		// Insiders was never touched.
		expect(JSON.parse(readFileSync(insiders, "utf8"))).toEqual({});
	});

	test("empty file or non-object JSON is left untouched", () => {
		const path = writeSettings("");
		const result = ensureSequenceTitle([path]);
		expect(result.status).toBe("failed");
		expect(readFileSync(path, "utf8")).toBe("");
	});

	test("nothing is written when no candidate exists (no mkdir side effects)", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-rename-vscode-none-"));
		try {
			const result = ensureSequenceTitle([join(base, "NeverCreated", "settings.json")]);
			expect(result.status).toBe("missing");
			expect(existsSync(join(base, "NeverCreated"))).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
