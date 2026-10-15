# GPT Tools

GPT Tools 是一款适用于 **Microsoft Edge** 的 ChatGPT 长对话渲染优化扩展，用于减轻长对话页面的渲染负担。

## 功能

- **长对话优化**：优先渲染当前浏览位置附近的消息，减少远处历史消息的布局开销。
- **历史内容保留**：不会删除聊天记录，向上滚动时可继续查看历史内容。
- **最新回复定位**：打开长对话时优先定位到最新回复；手动滚动后不强制跳转。
- **灵活设置**：支持一键开关，以及调整渲染窗口（1–10 轮，默认 3 轮）。

## 安装

1. 前往 [Releases](https://github.com/WendowEcho/GPT-Tools/releases) 下载最新的 `GPT-Tools-v*.zip`，并解压。
2. 在 Edge 地址栏打开 `edge://extensions`，开启**开发人员模式**。
3. 点击**加载解压缩的扩展**，选择解压后的 `extension` 文件夹。
4. 打开或刷新 [ChatGPT](https://chatgpt.com/)，点击扩展图标即可调整设置。

无需安装额外依赖，也无需编译。

## 更新

下载新版压缩包并解压，替换已加载的扩展文件，然后在 `edge://extensions` 中点击**重新加载**，最后刷新 ChatGPT 页面。
