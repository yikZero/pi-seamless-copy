<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

# pi-seamless-copy

Copy text from [Pi](https://pi.dev)'s fullscreen TUI without the line breaks that terminal-width wrapping added.

Pi wraps long lines to fit the terminal, and fullscreen selection copies the wrapped rows joined with `\n`. A paragraph pastes as several broken lines, Chinese text gets split mid-word, and a long shell command from a code block pastes as two commands. This extension makes selection copy rejoin those wraps while keeping the real line breaks.

| Selected | Pi | With pi-seamless-copy |
|---|---|---|
| Wrapped CJK paragraph | `…桌面、手机\n 、网页…` | `…桌面、手机、网页…` |
| Wrapped English paragraph | `…running across\n a line…` | `…running across a line…` |
| Long command in a code block | `… --report\n node_modules/…` | `… --report node_modules/…` |
| Several paragraphs | wraps and padding everywhere | paragraphs kept, wraps joined, padding removed |

## Install

```bash
pi install npm:pi-seamless-copy@0.1.0
```

Then run `/reload` or restart Pi. It works in fullscreen mode (`--tui-mode fullscreen`, the default since Pi 1.5) with the mouse-drag selection; there is nothing to configure.

## How it works

Instead of guessing from the copied text, the extension records where wraps happen while Pi renders, the way Grok Build and Codex keep wrap provenance in their own TUIs:

1. **Record.** It wraps the `renderToken` method of Pi's `Markdown` component (used for assistant, user, and thinking text, including list items, blockquotes, and code blocks) and the `render` method of `Text`. For every logical line that wraps, it aligns the wrapped rows with the source line and records each row pair with the exact whitespace the wrapper dropped (`" "` for English, nothing for CJK or long words).
2. **Copy.** It wraps `TuiAltScreen.getActiveSelectionText`. For each pair of selected rows it looks up the full rows in the record, also matching behind leading decorations such as `- `, `1. ` or `│ `. Recorded pairs are joined with their whitespace and the decoration is dropped; everything else stays a hard line break. Finally the left padding shared by the selected rows is removed.

If a row was not recorded, the copy is exactly what Pi would produce. If Pi's internals change so the patches cannot be installed, the extension shows a warning and leaves copying untouched.

## Limitations

- Only fullscreen selection copy is affected. Copying with your terminal's own selection outside fullscreen mode is unchanged.
- Only text rendered by Pi's `Markdown` and `Text` components is covered. Extensions that wrap text themselves, such as custom tool renderers, keep Pi's behavior.
- Tables are not reflowed; their rows stay as rendered.
- Rows are matched by their text. If the same pair of rows appears once as a wrap and elsewhere as a real line break, both are joined. In practice this needs two identical lines of text.
- It patches non-public Pi methods (`Markdown.prototype.renderToken`, `Text.prototype.render`, `TuiAltScreen.prototype.getActiveSelectionText`), so a Pi update can break it. Tested with Pi 1.5.2.

Pi upstream has discussed fixing this in core ([#8019](https://github.com/earendil-works/pi/issues/8019), [#11997](https://github.com/earendil-works/pi/issues/11997)). If that lands, this extension is no longer needed.

## Development

```bash
npm test          # unit tests, plus tests against the pi-tui of your installed Pi
npm run test:e2e  # drives a real Pi in a pty and checks the copied text (needs uv)
```

`scripts/e2e.py --baseline` runs the same checks without the extension to show Pi's default behavior; `--with-user-extensions` also loads your configured Pi packages.

## License

[MIT](./LICENSE)
