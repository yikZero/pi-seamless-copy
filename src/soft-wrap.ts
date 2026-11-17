/**
 * Pure soft-wrap bookkeeping, independent of Pi so it can be unit-tested.
 *
 * Pi's renderers wrap each logical line into display rows and only keep the rows. While a row is
 * produced we still know its logical line, so we record "row A continues into row B with joiner J"
 * here. Copy then looks rows up by their plain text and joins the recorded pairs.
 */

/**
 * Joiners between consecutive wrapped segments of one logical line.
 *
 * `result[i]` describes how segment `i` attaches to segment `i - 1`: the exact whitespace the
 * wrapper dropped (often `" "`, `""` for CJK or hard-broken words), or `undefined` when the segments
 * cannot be aligned with the source. `result[0]` is always `undefined`.
 */
export function computeJoiners(logical: string, segments: readonly string[]): (string | undefined)[] {
	if (segments.length === 0) return [];
	const joiners: (string | undefined)[] = [undefined];
	const first = segments[0]!.trimEnd();
	if (!logical.startsWith(first)) return segments.map(() => undefined);
	let position = first.length;
	for (let index = 1; index < segments.length; index++) {
		const segment = segments[index]!.trimEnd();
		const found = segment.length === 0 ? -1 : logical.indexOf(segment, position);
		const gap = found < 0 ? undefined : logical.slice(position, found);
		if (gap === undefined || !/^\s*$/.test(gap)) {
			// Alignment lost: leave the remaining rows as hard breaks.
			while (joiners.length < segments.length) joiners.push(undefined);
			return joiners;
		}
		joiners.push(gap);
		position = found + segment.length;
	}
	return joiners;
}

const SEPARATOR = "\u0000";
/** Containers prefix wrapped rows with short decorations ("- ", "1. ", "│ ", nested indents). */
const MAX_DECORATION_WIDTH = 32;

/**
 * Lookup keys for a screen row: the trimmed row, then the row without each leading
 * whitespace-separated decoration, so "- item" still matches the recorded "item".
 */
function rowKeys(row: string): string[] {
	const trimmed = row.trim();
	if (!trimmed) return [];
	const keys = [trimmed];
	const limit = Math.min(trimmed.length - 1, MAX_DECORATION_WIDTH);
	for (let index = 1; index <= limit; index++) {
		if (/\s/.test(trimmed[index - 1]!) && !/\s/.test(trimmed[index]!)) keys.push(trimmed.slice(index));
	}
	return keys;
}

export interface SoftWrapMatch {
	/** Whitespace the wrapper dropped between the rows. */
	joiner: string;
	/** Decoration repeated at the start of the continuation row, such as "│ ", to drop when joining. */
	decoration: string;
}

/** Bounded record of soft-wrapped row pairs, keyed by their trimmed plain text. */
export class SoftWrapRegistry {
	private readonly pairs = new Map<string, string>();
	private readonly capacity: number;

	constructor(capacity = 50_000) {
		this.capacity = capacity;
	}

	record(previousRow: string, nextRow: string, joiner: string): void {
		const previous = previousRow.trim();
		const next = nextRow.trim();
		if (!previous || !next) return;
		const key = previous + SEPARATOR + next;
		// Re-insert to keep recently rendered pairs at the young end of the eviction order.
		this.pairs.delete(key);
		this.pairs.set(key, joiner);
		if (this.pairs.size > this.capacity) {
			const oldest = this.pairs.keys().next().value;
			if (oldest !== undefined) this.pairs.delete(oldest);
		}
	}

	/** Record every soft wrap of one logical line given its plain text and plain wrapped rows. */
	recordLine(logical: string, segments: readonly string[]): void {
		if (segments.length < 2) return;
		const joiners = computeJoiners(logical, segments);
		for (let index = 1; index < segments.length; index++) {
			const joiner = joiners[index];
			if (joiner !== undefined) this.record(segments[index - 1]!, segments[index]!, joiner);
		}
	}

	/** How `nextRow` soft-wraps from `previousRow`, allowing leading decorations on either row. */
	match(previousRow: string, nextRow: string): SoftWrapMatch | undefined {
		const nextTrimmed = nextRow.trim();
		const nextKeys = rowKeys(nextRow);
		for (const previous of rowKeys(previousRow)) {
			for (const next of nextKeys) {
				const joiner = this.pairs.get(previous + SEPARATOR + next);
				if (joiner !== undefined) {
					return { joiner, decoration: nextTrimmed.slice(0, nextTrimmed.length - next.length) };
				}
			}
		}
		return undefined;
	}

	get size(): number {
		return this.pairs.size;
	}

	clear(): void {
		this.pairs.clear();
	}
}

function leadingSpaces(text: string): number {
	return /^ */.exec(text)![0].length;
}

/**
 * Rebuild selection text from per-row slices.
 *
 * `slices[i]` is the selected text of screen row `i` as Pi copies it; `rows[i]` is the full plain
 * text of that row. Recorded soft wraps are joined and everything else stays a hard break. The left
 * gutter shared by all selected rows (such as message padding) is removed from each line.
 */
export function joinSelectedRows(
	slices: readonly string[],
	rows: readonly string[],
	match: (previousRow: string, nextRow: string) => SoftWrapMatch | undefined,
): string {
	let gutter = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		if (row.trim() !== "") gutter = Math.min(gutter, leadingSpaces(row));
	}
	if (!Number.isFinite(gutter)) gutter = 0;

	const lines: string[] = [slices[0] ?? ""];
	for (let index = 1; index < slices.length; index++) {
		const slice = slices[index] ?? "";
		const wrap = match(rows[index - 1] ?? "", rows[index] ?? "");
		if (wrap === undefined) {
			lines.push(slice);
			continue;
		}
		let continuation = slice.trimStart();
		if (wrap.decoration && continuation.startsWith(wrap.decoration)) {
			continuation = continuation.slice(wrap.decoration.length).trimStart();
		}
		lines[lines.length - 1] = lines[lines.length - 1]!.trimEnd() + wrap.joiner + continuation;
	}
	// A line starting inside the gutter carries part of it; one starting later carries none.
	return lines.map((line) => line.slice(Math.min(gutter, leadingSpaces(line)))).join("\n");
}
