# 更新日志

## v0.5.7 — 2026-09-16

- `/resume` 无参数时打开交互式历史任务选择面板，不再只是重复打印 `/tasks`。
- 恢复面板只展示当前工作目录的任务；选择后加载完整对话并恢复原模型绑定。

## v0.5.6 — 2026-09-16

- 明确普通输入与历史恢复边界：每次普通输入默认创建新的会话；只有 `/resume` 恢复的任务才继续历史上下文。
- 保留旧任务在当前工作区历史中，避免因新会话丢失代码任务。

## v0.5.5 — 2026-09-16

- 普通输入默认创建新的会话；只有通过 `/resume` 恢复的历史任务才会继续原上下文。
- 原任务保留在当前工作区历史中，使用 `/resume` 可再次恢复。
- 修复 Ctrl+C 只停止当前回复、不会清空原生 Agent 上下文导致的误续写问题。

## v0.5.4 — 2026-09-16

- 新增 `/resume`，按当前工作目录列出和恢复历史任务。
- `/tasks` 改为只显示当前工作目录的任务，防止跨项目暴露或恢复历史会话。
- 恢复任务时重新打开原模型绑定、上下文快照和对话记录，并保留工作区信任边界。

## v0.5.3 — 2026-09-16

- 首屏改为品牌 Logo、版本、模型状态、工作目录、Ready 状态和 `Ask your question...` 输入区。
- 思考显示为可折叠的耗时行，工具调用显示 `SKILL`、`READ`、`SHELL`、`WRITE` 等标签，回复完成后显示耗时。
- 默认不启用鼠标上报，恢复终端原生拖选和 Cmd+C 复制；滚轮接管改为 `HABOR_MOUSE_SCROLL=1`。
- 增加工作区信任确认：首次选择模型前询问目录是否可信，记录到 `~/.habor/trust.json`。
- 核实并加入 Grok Build 官方 CLI 的原生终端管理入口。

## v0.5.2 — 2026-09-16

- 默认关闭鼠标上报，恢复 macOS Terminal / iTerm 的原生拖选和复制；滚轮接管改为 `HABOR_MOUSE_SCROLL=1` 可选项。
- 首次选择模型进入工作区时增加“Do you trust the files in this folder?”确认。
- 信任按规范化工作区路径保存到 `~/.habor/trust.json`；拒绝时退出，确认后才创建 Agent 任务。
- 补充 Grok Build 官方 CLI、安装入口、浏览器/API Key 认证说明和原生独立终端管理。

## v0.5.1 — 2026-09-16

- 默认关闭终端鼠标上报，恢复 macOS Terminal / iTerm 的原生拖选与 Cmd+C 复制。
- 保留 PgUp / PgDn 键盘滚动；设置 `HABOR_MOUSE_SCROLL=1` 后才由 habor 接管滚轮。
- 增加终端鼠标选择回归测试，避免后续 UI 改动重新阻断原生复制。

## v0.5.0 — 2026-09-14

本版本将 Agent 安装、原生登录与 API 来源配置整合到 habor 的终端交互中。

### 新增

- F5 / `/agents` 管理 Agent，`/login` 管理当前 Agent 的认证。
- 为 Codex、Claude Code、Kimi Code、DeepSeek Harness、Gemini CLI 和 Qwen Code 提供官方 npm 包自动安装。
- 使用 habor 私有安装目录及 npm 缓存，显示安装进度、耗时和取消入口；校验成功后启用，失败保留原有版本。
- 提供原生浏览器授权、设备码、官方 API Key 与自定义来源的选择入口。
- 认证时由官方客户端接管终端，完成或取消后恢复界面与草稿；授权文本不进入任务历史。
- Gemini CLI / Qwen Code 的独立原生终端入口，可完成原生认证并使用 `/model` 选择型号。
- 补充 Claude Fable 5.1、Opus 5、Sonnet 5、DeepSeek V4.1 Flash 和 GPT-5.6 系列的模型条目。
- 新增主流模型、官方客户端和认证方式的来源清单。

### 修复

- 未安装 Agent 的模型保留在列表中并标为待安装，保存 API Key 后可以继续完成安装。
- 安装后重新检测客户端路径；ZCode 不再只在进程启动时检测一次。
- 明确区分本机客户端凭据与 habor API 来源 Key，改善 DSH 缺失凭据提示。
- 原生终端返回后完整重绘，修复多行安装错误破坏终端布局的问题。
- 针对 DSH 旧版依赖解析与桥接兼容问题，安装固定版本及显式兼容依赖集合。

### 支持范围

- Codex、Claude Code、Kimi Code、DSH、ZCode 支持 habor 统一任务会话。
- Gemini / Qwen 当前使用独立原生终端，不自动继承 habor 任务文本或共享其消息流。
- ZCode 使用官方桌面安装入口；本版本不提供未经核实的 npm 安装方式。
- 自动安装支持 macOS / Linux；Windows 推荐 WSL，原生自动安装暂未实现。
- DSH 使用已验证的 `0.1.0-rc.8` 及兼容依赖；当前桥接不支持 `0.1.5-rc.1`。模型版本与 Agent 版本独立，仍可调用 V4.1 Flash。

### 安装

要求 Node.js 22.19.0 或更新版本，以及 pnpm。下载本 Release 的源码，或检出 `v0.5.0` 标签，然后运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm habor
```

启动后按 F2 选择模型，F3 配置来源，F4 调整思考强度，F5 管理 Agent。
本 Release 提供源码；不包含独立平台二进制，也不自动发布到 npm registry。

### 验证

- 57 项自动测试通过。
- 无 Agent 的初次配置、API 来源切换、认证终端取消与恢复流程通过伪终端测试。
- 真实 Codex 官方 npm 安装验证通过。
- DSH 兼容安装通过原生请求、模型 / Key / 地址及 low / max 思考参数验证，原生 Web 配置入口返回 HTTP 200。
