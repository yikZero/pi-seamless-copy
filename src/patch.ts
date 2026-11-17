import { joinSelectedRows, SoftWrapRegistry } from "./soft-wrap.ts";

/** The parts of `@earendil-works/pi-tui` this package touches, injected for testability. */
export interface PiTuiApi {
	Markdown: { prototype: object };
	Text: { prototype: object };
	TuiAltScreen: { prototype: object };
	wrapTextWithAnsi(text: string, width: number): string[];
	stripTerminalSequences(text: string): string;
}

type AnyFunction = (this: any, ...args: any[]) => any;
type Prototype = Record<string, unknown>;

interface InstalledState {
	registry: SoftWrapRegistry;
	restore?: () => void;
}

// Shared across /reload so pairs recorded before a reload keep working for cached rows.
const STATE_KEY = Symbol.for("pi-seamless-copy.state");

function sharedState(): InstalledState {
	const holder = globalThis as unknown as Record<symbol, InstalledState | undefined>;
	holder[STATE_KEY] ??= { registry: new SoftWrapRegistry() };
	return holder[STATE_KEY]!;
}

function isImageLine(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function recordWrappedLines(api: PiTuiApi, registry: SoftWrapRegistry, lines: readonly string[], width: number): void {
	for (const line of lines) {
		if (!line || isImageLine(line)) continue;
		const segments = api.wrapTextWithAnsi(line, width);
		if (segments.length < 2) continue;
		registry.recordLine(
			api.stripTerminalSequences(line),
			segments.map((segment) => api.stripTerminalSequences(segment)),
		);
	}
}

interface ScrollBox {
	scrollView?: unknown;
	scrollContentLines?: string[];
	children?: ScrollBox[];
}

function findScrollBox(box: ScrollBox | undefined, scrollView: unknown): ScrollBox | undefined {
	if (!box) return undefined;
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const match = findScrollBox(child, scrollView);
		if (match) return match;
	}
	return undefined;
}

interface SelectionPoint {
	row: number;
	scrollView?: unknown;
}

/** Full plain rows behind the active selection, or undefined when the internals look different. */
function selectedRows(screen: any, api: PiTuiApi): string[] | undefined {
	const bounds: { start: SelectionPoint; end: SelectionPoint } | undefined = screen.getSelectionBounds?.();
	if (!bounds) return undefined;
	let source: unknown = screen.previousScreen;
	if (bounds.start.scrollView) {
		source = findScrollBox(screen.currentLayout?.root, bounds.start.scrollView)?.scrollContentLines;
	}
	if (!Array.isArray(source)) return undefined;
	const rows: string[] = [];
	for (let row = bounds.start.row; row <= bounds.end.row; row++) {
		rows.push(api.stripTerminalSequences(String(source[row] ?? "")));
	}
	return rows;
}

function wrapMethod(prototype: Prototype, name: string, build: (original: AnyFunction) => AnyFunction): () => void {
	const original = prototype[name];
	if (typeof original !== "function") {
		throw new Error(`pi-seamless-copy: ${name} not found; this Pi version is not supported`);
	}
	const patched = build(original as AnyFunction);
	prototype[name] = patched;
	return () => {
		if (prototype[name] === patched) prototype[name] = original;
	};
}

/** Install the render and copy patches; returns the shared registry. Safe to call again on reload. */
export function install(api: PiTuiApi): SoftWrapRegistry {
	const state = sharedState();
	state.restore?.();
	const { registry } = state;
	const restores: (() => void)[] = [];

	try {
		// Markdown's renderToken(token, width) returns unwrapped lines that its caller then wraps at that
		// same width: renderBlock for top-level blocks, renderList for items, blockquotes for their children.
		restores.push(
			wrapMethod(api.Markdown.prototype as Prototype, "renderToken", (original) =>
				function (this: any, token: unknown, width: unknown, ...rest: unknown[]) {
					const lines = original.call(this, token, width, ...rest);
					if (Array.isArray(lines) && typeof width === "number") {
						try {
							recordWrappedLines(api, registry, lines as string[], width);
						} catch {
							// Recording is best effort; never break rendering.
						}
					}
					return lines;
				},
			),
		);

		// Text wraps its whole text at the content width left after horizontal padding.
		restores.push(
			wrapMethod(api.Text.prototype as Prototype, "render", (original) =>
				function (this: any, width: number) {
					const cached = this.cachedLines && this.cachedText === this.text && this.cachedWidth === width;
					const result = original.call(this, width);
					if (!cached && typeof this.text === "string" && this.text.trim() !== "") {
						try {
							const paddingX = Math.min(this.paddingX ?? 0, Math.max(0, Math.floor((width - 1) / 2)));
							const contentWidth = Math.max(1, width - paddingX * 2);
							const lines = this.text.replace(/\t/g, "   ").split(/\r\n|\r|\n/);
							recordWrappedLines(api, registry, lines, contentWidth);
						} catch {
							// Best effort.
						}
					}
					return result;
				},
			),
		);

		// Fullscreen selection copy: join recorded soft wraps instead of every row break.
		restores.push(
			wrapMethod(api.TuiAltScreen.prototype as Prototype, "getActiveSelectionText", (original) =>
				function (this: any) {
					const text: string | undefined = original.call(this);
					if (text === undefined || (!text.includes("\n") && !text.startsWith(" "))) return text;
					try {
						const rows = selectedRows(this, api);
						const slices = text.split("\n");
						if (!rows || rows.length !== slices.length) return text;
						return joinSelectedRows(slices, rows, (previous, next) => registry.match(previous, next));
					} catch {
						return text;
					}
				},
			),
		);
	} catch (error) {
		for (const restore of restores.reverse()) restore();
		throw error;
	}

	state.restore = () => {
		for (const restore of restores.reverse()) restore();
		state.restore = undefined;
	};
	return registry;
}

/** Remove the patches installed by `install`, if any. */
export function uninstall(): void {
	sharedState().restore?.();
}
