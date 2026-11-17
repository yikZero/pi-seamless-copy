<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

# pi-seamless-copy

在 [Pi](https://pi.dev) 全屏模式下选中复制时，去掉因终端宽度自动折行产生的换行。

Pi 会按终端宽度折行，全屏模式的选中复制又把屏幕上的每一行用换行符拼起来。结果是一段话粘贴出来断成好几行，中文在词中间被切开，代码块里的长命令粘贴到终端变成两条命令。这个插件让复制时把自动折行接回去，原文本来的换行保持不变。

| 选中的内容 | Pi 默认 | 装上之后 |
|---|---|---|
| 折行的中文段落 | `…桌面、手机\n 、网页…` | `…桌面、手机、网页…` |
| 折行的英文段落 | `…running across\n a line…` | `…running across a line…` |
| 代码块里的长命令 | `… --report\n node_modules/…` | `… --report node_modules/…` |
| 跨多个段落 | 到处是折行和左侧留白 | 段落保留，折行接回，留白去掉 |

## 安装

```bash
pi install npm:pi-seamless-copy@0.1.0
```

装好后执行 `/reload` 或重启 Pi。只在全屏模式（`--tui-mode fullscreen`，Pi 1.5 起默认）下用鼠标拖选复制时生效，不需要配置。

## 原理

插件不靠猜，而是在 Pi 渲染时记下哪里是自动折行，思路和 Grok Build、Codex 在自己的 TUI 里记录折行信息一样：

1. **记录**：包装 Pi 的 `Markdown` 组件的 `renderToken` 方法（助手回复、用户消息、思考内容都用它渲染，包括列表、引用和代码块），以及 `Text` 组件的 `render` 方法。每遇到一行原文被折成多行，就把折出来的行和原文对齐，记下相邻两行，以及折行时被切掉的那段空白：英文是一个空格，中文和被硬切的长词是空字符串。
2. **复制**：包装 `TuiAltScreen.getActiveSelectionText`。对选区里每相邻两行，用完整的行去查记录；行首有 `- `、`1. `、`│ ` 这类装饰也能匹配上。查到的就用记录的空白接起来，并去掉续行的装饰；查不到的保留原来的换行。最后去掉所有选中行共有的左侧留白。

没有记录的行，复制结果和 Pi 原来完全一样。如果 Pi 内部实现变了、补丁装不上，插件会给出提示，复制保持 Pi 的默认行为。

## 限制

- 只影响全屏模式下的选中复制。非全屏时用终端自己的选中复制，不受影响。
- 只覆盖 Pi 的 `Markdown` 和 `Text` 组件渲染的文字。自己折行的插件（比如自定义的工具输出渲染）保持 Pi 原来的行为。
- 表格不重排，按渲染出来的样子复制。
- 按行的文字匹配。如果同样的两行文字在一处是自动折行、另一处是原文换行，两处都会被接起来；这需要出现两行完全相同的文字，实际很少见。
- 补丁用到了 Pi 的非公开方法（`Markdown.prototype.renderToken`、`Text.prototype.render`、`TuiAltScreen.prototype.getActiveSelectionText`），Pi 升级后可能失效。已在 Pi 1.5.2 上测试。

Pi 上游讨论过在核心里修这个问题（[#8019](https://github.com/earendil-works/pi/issues/8019)、[#11997](https://github.com/earendil-works/pi/issues/11997)）。如果上游修好了，就不再需要这个插件。

## 开发

```bash
npm test          # 单元测试，以及针对本机已安装 Pi 的 pi-tui 的测试
npm run test:e2e  # 在 pty 里驱动真实的 Pi，检查复制出来的文字（需要 uv）
```

`scripts/e2e.py --baseline` 不加载插件跑同样的检查，用来对照 Pi 的默认行为；`--with-user-extensions` 会同时加载你已配置的 Pi 插件。

## 许可证

[MIT](./LICENSE)
