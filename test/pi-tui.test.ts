// Runs the patches against a real @earendil-works/pi-tui. Point PI_TUI_PATH at its dist/index.js;
// by default the test uses the copy shipped with the locally installed Pi.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { install, uninstall } from "../src/patch.ts";
import type { SoftWrapRegistry } from "../src/soft-wrap.ts";

function locatePiTui(): string | undefined {
	if (process.env.PI_TUI_PATH) return process.env.PI_TUI_PATH;
	try {
		const pi = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
		const agentDir = dirname(dirname(pi));
		const version = execFileSync("cat", [join(agentDir, "install", "current-version")], { encoding: "utf8" }).trim();
		const candidate = join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

const piTuiPath = locatePiTui();

describe("with real pi-tui", { skip: piTuiPath ? false : "pi-tui not found; set PI_TUI_PATH" }, () => {
	let tui: any;
	let registry: SoftWrapRegistry;
	const plain = (line: string) => tui.stripTerminalSequences(line);
	const identity = (text: string) => text;
	const theme = new Proxy(
		{},
		{
			get: (_target, key) => {
				if (key === "codeBlockIndent") return "  ";
				if (key === "highlightCode" || key === "then") return undefined;
				return identity;
			},
		},
	);

	before(async () => {
		tui = await import(pathToFileURL(piTuiPath!).href);
		registry = install(tui);
		registry.clear();
	});
	after(() => uninstall());

	/** Select whole rows `[from, to]` of `lines` on a fake fullscreen screen and copy them. */
	function copyRows(lines: string[], from: number, to: number, startCol = 0): string | undefined {
		const screen = Object.create(tui.TuiAltScreen.prototype);
		screen.previousScreen = lines;
		screen.selectionAnchor = { row: from, col: startCol };
		screen.selectionFocus = { row: to, col: tui.visibleWidth(lines[to]!), boundary: true };
		return screen.getActiveSelectionText();
	}

	it("copies a wrapped CJK paragraph from Markdown as one line", () => {
		const text = "第二段：下面这句稍长一点，方便检查自动换行。OneKey 钱包支持桌面、手机、网页和浏览器扩展，复制时如果中间被拆成两行，粘贴回去应该仍然连在一起。";
		const lines: string[] = new tui.Markdown(text, 1, 0, theme).render(40);
		assert.ok(lines.length > 2, "expected the paragraph to wrap");
		assert.equal(copyRows(lines, 0, lines.length - 1), text);
	});

	it("keeps paragraphs and list items apart while joining their wraps", () => {
		const source = [
			"First paragraph that is long enough to wrap across a couple of rows here.",
			"",
			"- a list item that is also long enough to wrap onto the next row",
			"- second item",
		].join("\n");
		const lines: string[] = new tui.Markdown(source, 1, 0, theme).render(30);
		const copied = copyRows(lines, 0, lines.length - 1);
		assert.equal(
			copied,
			[
				"First paragraph that is long enough to wrap across a couple of rows here.",
				"",
				"- a list item that is also long enough to wrap onto the next row",
				"- second item",
			].join("\n"),
		);
	});

	it("joins wraps inside blockquotes and nested lists", () => {
		const source = [
			"> A quoted sentence that is long enough to wrap inside the quote border.",
			"",
			"1. Ordered item",
			"   - nested bullet that keeps going long enough to wrap again",
		].join("\n");
		const lines: string[] = new tui.Markdown(source, 1, 0, theme).render(32);
		const copied = copyRows(lines, 0, lines.length - 1);
		assert.equal(
			copied,
			[
				"│ A quoted sentence that is long enough to wrap inside the quote border.",
				"",
				"1. Ordered item",
				"    - nested bullet that keeps going long enough to wrap again",
			].join("\n"),
		);
	});

	it("restores a long shell command wrapped inside a code block", () => {
		const command = "yarn agent:check --profile pr --verbose --report node_modules/.cache/agent-checks/report.json";
		const lines: string[] = new tui.Markdown("```sh\n" + command + "\n```", 1, 0, theme).render(40);
		const codeRows = lines
			.map((line, index) => ({ line: plain(line), index }))
			.filter(({ line }) => !line.includes("```"));
		const copied = copyRows(lines, codeRows[0]!.index, codeRows.at(-1)!.index);
		assert.equal(copied?.trim(), command);
	});

	it("joins wrapped Text output", () => {
		const text = "Text components wrap too, for example tool output that runs past the terminal width.";
		const lines: string[] = new tui.Text(text, 1, 0).render(30);
		assert.equal(copyRows(lines, 0, lines.length - 1), text);
	});

	it("leaves unrecorded rows alone", () => {
		assert.equal(copyRows(["first row", "second row"], 0, 1), "first row\nsecond row");
	});
});
