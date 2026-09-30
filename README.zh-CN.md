# habor

> 一个原生桌面工作台：选择模型、运行它们的原生 Agent，并在单人任务与协作任务之间继续同一个上下文。

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

habor 保留代码终端的直接感，同时给本地任务草稿一个稳定的桌面工作区。当前预发布版只开放本地任务、最近任务、命令面板、语言切换和原生窗口能力。

## 功能

- **原生桌面壳**：Tauri 2 + Rust Host，支持 macOS 原生窗口、菜单、托盘和 Windows WebView2。
- **本地任务工作台**：创建任务草稿、追加指令，并在本机保存最近任务。
- **原生桌面壳**：支持 Tauri 菜单、托盘、`⌘K` / `Ctrl+K` 命令面板和原生窗口行为。
- **共享运行时边界**：现有 CLI、Router、ACP 和原生 harness 继续作为 Agent 的生产入口。
- **多国语言**：英语、简体中文、繁体中文、日语、韩语、西班牙语；选择“跟随系统”即可使用系统语言。
- **快捷键优先**：`⌘K` / `Ctrl+K` 打开命令面板，用于切换任务、视图和上下文面板。

## 快速开始

需要 Node.js 22.19 或更新版本、pnpm 11，以及用于原生桌面壳的 Rust stable。

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm build
pnpm habor
```

启动桌面预览：

```sh
pnpm --filter @agent-router/desktop tauri:dev
```

## 桌面端状态

首版桌面端位于 `packages/desktop`，使用 Tauri 2 原生窗口、Rust 系统能力和 React 内容区。当前版本只呈现已实现的本地任务和桌面壳能力；模型路由、实时 Agent、审批、文件、Diff、Verify 和协作流程会在 App Server 接入后再加入。

## 仓库结构

```text
packages/
├── core/       Agent、Session、Event、Workspace 共享契约
├── router/     模型到 harness 路由、任务亲和性和状态
├── adapters/   原生 ACP 客户端和 legacy bridge
├── cli/        habor 终端客户端
├── dsh-acp/    DeepSeek Harness ACP server
└── desktop/    Tauri 2 壳和 React 工作台
```

## 验证

```sh
pnpm test
pnpm --filter @agent-router/desktop test:sites
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## 路线图

- [x] 共享 Router、ACP、原生 Agent 适配器和 CLI 任务状态
- [x] Tauri 2 原生桌面壳、本地任务、命令面板和多语言 UI
- [ ] 接入桌面 App Server sidecar，订阅实时任务事件并恢复会话
- [ ] 加入模型选择、原生 Agent、流式对话、工具、审批、Files、Diff 和 Verify
- [ ] 加入 Collaborate 成员通信、独立审批和流程模板
- [ ] CLI 与桌面窗口共享同一任务状态
- [ ] 完善成员通信、独立审批和协作模板
- [ ] 发布签名的 macOS、Windows、Linux 安装包

## 贡献

提交问题时请附操作系统、任务模式、界面语言和最小复现步骤。Pull Request 应保持共享 Router 契约稳定，并附上相关构建或测试命令。

## 许可证

见 [LICENSE](LICENSE)。
