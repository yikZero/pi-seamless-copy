import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeJoiners, joinSelectedRows, SoftWrapRegistry } from "../src/soft-wrap.ts";

describe("computeJoiners", () => {
	it("recovers the space dropped between English words", () => {
		assert.deepEqual(computeJoiners("hello brave new world", ["hello brave", "new world"]), [undefined, " "]);
	});

	it("joins CJK rows without a space", () => {
		assert.deepEqual(computeJoiners("复制时如果中间被拆成两行，粘贴回去", ["复制时如果中间被拆成两行，粘", "贴回去"]), [undefined, ""]);
	});

	it("keeps runs of spaces exactly", () => {
		assert.deepEqual(computeJoiners("a  b", ["a", "b"]), [undefined, "  "]);
	});

	it("joins hard-broken long words with nothing", () => {
		assert.deepEqual(computeJoiners("https://example.com/very/long", ["https://exam", "ple.com/very", "/long"]), [undefined, "", ""]);
	});

	it("gives up when segments do not align with the source", () => {
		assert.deepEqual(computeJoiners("abc def", ["abc", "xyz"]), [undefined, undefined]);
		assert.deepEqual(computeJoiners("abc def", ["zzz", "def"]), [undefined, undefined]);
	});
});

describe("SoftWrapRegistry", () => {
	it("looks pairs up by trimmed row text", () => {
		const registry = new SoftWrapRegistry();
		registry.recordLine("第二段：下面这句稍长一点", ["第二段：下面这", "句稍长一点"]);
		assert.equal(registry.match(" 第二段：下面这   ", " 句稍长一点 ")?.joiner, "");
		assert.equal(registry.match("第二段：下面这", "别的行"), undefined);
	});

	it("evicts the oldest pairs beyond capacity", () => {
		const registry = new SoftWrapRegistry(2);
		registry.record("a", "b", " ");
		registry.record("c", "d", " ");
		registry.record("e", "f", " ");
		assert.equal(registry.size, 2);
		assert.equal(registry.match("a", "b"), undefined);
		assert.equal(registry.match("e", "f")?.joiner, " ");
	});
});

describe("joinSelectedRows", () => {
	const registry = new SoftWrapRegistry();
	registry.recordLine("OneKey 钱包支持桌面、手机，复制时如果中间被拆成两行，粘贴回去应该仍然连在一起。", [
		"OneKey 钱包支持桌面、手机，复制时如果中间被拆成两行，粘",
		"贴回去应该仍然连在一起。",
	]);
	registry.recordLine("The quick brown fox jumps over the lazy dog", ["The quick brown fox", "jumps over the lazy dog"]);
	const lookup = (previous: string, next: string) => registry.match(previous, next);

	it("joins soft wraps and keeps hard breaks", () => {
		const rows = [
			" OneKey 钱包支持桌面、手机，复制时如果中间被拆成两行，粘",
			" 贴回去应该仍然连在一起。",
			"",
			" The quick brown fox",
			" jumps over the lazy dog",
		];
		const slices = rows.map((row) => row.trimEnd());
		assert.equal(
			joinSelectedRows(slices, rows, lookup),
			"OneKey 钱包支持桌面、手机，复制时如果中间被拆成两行，粘贴回去应该仍然连在一起。\n\nThe quick brown fox jumps over the lazy dog",
		);
	});

	it("joins a partial selection across one wrap", () => {
		const rows = [" The quick brown fox", " jumps over the lazy dog"];
		assert.equal(joinSelectedRows(["brown fox", " jumps"], rows, lookup), "brown fox jumps");
	});

	it("leaves unknown rows as hard breaks and removes the shared gutter", () => {
		const rows = [" line one", " line two", "    indented"];
		assert.equal(joinSelectedRows(["line one", " line two", "    indented"], rows, lookup), "line one\nline two\n   indented");
		assert.equal(joinSelectedRows([" line one", " line two"], rows.slice(0, 2), lookup), "line one\nline two");
	});

	it("matches rows behind list and quote decorations", () => {
		const local = new SoftWrapRegistry();
		local.recordLine("a list item that wraps onto the next row", ["a list item that wraps", "onto the next row"]);
		assert.deepEqual(local.match(" - a list item that wraps", "   onto the next row"), { joiner: " ", decoration: "" });
		assert.deepEqual(local.match(" │ a list item that wraps", " │ onto the next row"), { joiner: " ", decoration: "│ " });
		assert.equal(local.match(" - something else", "   onto the next row"), undefined);
		assert.equal(
			joinSelectedRows([" │ a list item that wraps", " │ onto the next row"], [" │ a list item that wraps", " │ onto the next row"], (a, b) => local.match(a, b)),
			"│ a list item that wraps onto the next row",
		);
	});
});
