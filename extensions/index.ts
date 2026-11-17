import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, Text, TuiAltScreen, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { install } from "../src/patch.ts";

export default function (pi: ExtensionAPI): void {
	let failure: string | undefined;
	try {
		install({ Markdown, Text, TuiAltScreen, wrapTextWithAnsi, stripTerminalSequences });
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	if (failure) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`${failure}. Copy falls back to Pi's default behavior.`, "warning");
		});
	}
}
