# GPT Tools — Bounded Render

Microsoft Edge 上的 ChatGPT 长对话渲染优化扩展，适用于 `https://chatgpt.com/`。

**0.5.0 起仅保留 Bounded Render。** 已删除终端执行、Fast Copy、代码折叠、原生侧栏控制、Native Messaging Host 和它们的测试及构建脚本。扩展不申请 `nativeMessaging` 权限，不访问剪贴板，不通过后台进程执行命令。

## 原理

`render/bounded-render.js` 使用增量的 DOM 观察与复用的 IntersectionObserver / ResizeObserver，按可见位置将对话轮次归入 active、warm、cold。仅将远处的 cold 历史轮次设置为 `content-visibility: hidden`，配合缓存或估计的 `contain-intrinsic-size` 减少长会话布局工作。不会删除历史 DOM。加载会话时沿用原有的有界尾部定位逻辑，用户开始手动滚动后停止自动纠正。

优化依赖 ChatGPT 页面中 `data-testid^="conversation-turn-"` 节点；未来 UI 结构变化可能令优化不起作用。可随时关闭渲染开关恢复原生布局。

## 安装及更新

1. 更新本地仓库：`git pull --ff-only origin main`。
2. 打开 Edge 的 `edge://extensions`，开启开发人员模式。
3. 已安装 GPT Tools：点击扩展卡片的“重新加载”，再刷新 ChatGPT 标签页。
4. 尚未安装：加载解压缩扩展，选择 `gpt tools/extension` 目录。

无需 Go、Native Host、依赖安装或构建操作。

## 设置

- `boundedRenderEnabled`：默认 `true`，开启或关闭渲染优化。
- `renderWindowTurns`：默认 `3`，允许 1–10 轮。

旧版 `terminalExecuteEnabled`、`fastCopyEnabled` 等历史存储键将不再读取或生效。

## 本地旧版改动阻止 git pull 时

如果 Git 提示旧版 `gpt tools` 文件或根目录 `.DS_Store` 有未提交修改，先用**限定路径**的 stash 备份，再拉取新版本：

```zsh
cd "/Users/bozhang/Projects/Python/Tools"
git stash push -u -m "backup-legacy-gpt-tools-before-render-only" -- .DS_Store "gpt tools/"
git pull --ff-only origin main
git status --short
```

此命令不会把仓库根目录下的 `results/` 放入 stash，也不会覆盖其中内容；旧版终端功能修改被保存在 stash 中，但**不要执行 `git stash pop`**，因为新版刻意删除了这些文件。根目录 `.DS_Store` 已从 Git 跟踪中删除并受现有 `.gitignore` 排除。

## 只读静态检查

```zsh
cd "/Users/bozhang/Projects/Python/Tools"
python3 "gpt tools/verify_extension.py"
python3 "gpt tools/scripts/verify-tail-first-bounded-render.py"
```

静态检查不会启动浏览器或执行实验。真实性能需要在 Edge 上使用长对话进行人工观察。

## 可选：清理 Mac 上已安装的旧终端桥接程序

删除 Git 仓库源码**不会自动卸载**旧版 Native Messaging Host。如已确定不再有其他扩展依赖它，可在本机运行：

```zsh
rm -f "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.local.gpt_edge_terminal.json" "$HOME/Library/Application Support/GptEdgeTerminal/bin/gpt-terminal-bridge"
```

只删除指定的旧版注册文件与可执行程序，不删除其他用户配置。
