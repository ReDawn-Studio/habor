# habor — 原生 Agent 聚合平台

> 用户只选「模型」，任务自动跑在对应厂商的**原生 agent（harness）**里。
> 不是又一个"支持 N 个模型的 IDE"，而是"N 个原生 Agent 的聚合平台"。

```
                IDE / CLI（用户只看到模型）
                         │
                ┌────────▼────────┐
                │   Orchestrator   │  Task / Flow
                └────────┬────────┘
                ┌────────▼────────┐
                │     Router      │  按「模型 → 原生 harness」路由，带 Task 亲和性
                └────────┬────────┘
                ┌────────▼────────┐
                │ Protocol/Gateway│  ACP（JSON-RPC over stdio）/ CLI 子进程
                └────────┬────────┘
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
 DeepSeek Harness   Claude Code        Codex ...
        └────────────────┼────────────────┘
                  State 层（核心差异化）
        Session / Conversation / Context / Memory /
        Task / Workspace / Checkpoint / Artifact
```

## 终端对话

要求 Node.js 22.19.0 或更新版本，以及 pnpm。下载 Release 源码或克隆仓库后执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm habor
# 本机已安装 habor 启动器时，也可直接运行 habor
```

交互终端使用统一的深灰主题、暖色强调和自适应布局。输入 `/` 即时打开命令菜单；
启动后会自动打开模型选择面板，直接按 ↑↓ 选择、Enter 确认，无需输入模型名称。
`/model`、`/models` 或 F2 随时打开面板，默认定位当前模型；输入文字可筛选，Esc 返回。
F2 打开面板时会保留原有草稿和光标位置。
模型连接前也会显示欢迎页，启动时无需等待空白屏幕。

| 操作 | 快捷键 |
|---|---|
| 选择 / 切换模型 | F2 或 `/model`，然后 ↑↓、Enter |
| 调整当前模型思考强度 | F4 或 `/effort` |
| 管理 Agent 安装与认证 | F5 或 `/agents`；`/login` 管理当前 Agent |
| 发送消息 | Enter |
| 插入换行 | Alt+Enter / Ctrl+J；支持相应键盘协议的终端也可用 Shift+Enter |
| 编辑输入 | ← →、Home / End、Ctrl+A / E、Ctrl+U / K / W |
| 历史输入 / 多行移动 | ↑ ↓（在多行输入边界进入历史） |
| 浏览对话 | PgUp / PgDn、Shift+↑↓；Esc 回到底部 |
| 展开思考与完整工具输出 | Ctrl+O |
| 复制最近一段回复 | Ctrl+Y |
| 清空屏幕，保留任务 | Ctrl+L / `/clear` |
| 停止当前回复 | Esc / Ctrl+C（命令菜单打开时 Esc 先收起菜单） |
| 退出 | `/quit`；空草稿下连按两次 Ctrl+C |

运行时可以继续编辑下一条草稿，回复结束后按 Enter 发送。粘贴多行内容不会自动发送。
停止回复后保留当前任务和已收到的回答，后续输入会在同一模型上重建连接并带入任务上下文。
工具结果按调用 ID 匹配；思考与长输出默认折叠，输入/输出 token 数放在状态栏。
默认由终端处理鼠标拖选和复制：直接拖动选择后使用终端的 Cmd+C / Ctrl+Shift+C。
需要 habor 接管滚轮时设置 `HABOR_MOUSE_SCROLL=1`；此模式下按住终端支持的 Shift / Option 再拖动选择。

首次选择模型进入一个未信任的目录时，会显示工作区信任确认。选择“是，继续”后才会创建 Agent 任务；选择“否，退出”会退出 habor。
确认记录保存在 `~/.habor/trust.json`，按工作区目录分别保存；也可以使用 `/trust` 再次打开确认面板。

普通输入默认创建新的会话；历史任务按工作目录隔离。`/tasks` 只列出 habor 当前任务，`/resume` 打开当前目录的统一历史面板，其中包含 habor、Codex、Claude Code、Kimi Code 的官方会话；恢复后会把官方历史导入当前模型上下文。其他目录的任务不会显示或被恢复。

输入或输出不是 TTY、或 `TERM=dumb` 时回退到原有日志模式。
`HABOR_STATE_DIR` 可指定独立的状态目录，默认仍为 `~/.habor`。

验证：`pnpm test` 运行构建和交互/路由回归测试；
macOS / Linux 可运行 `python3 packages/cli/test/pty-smoke.py` 检查真实伪终端的输入、缩放及退出恢复。
测试不调用付费模型，PTY 检查使用临时状态目录。
`python3 packages/cli/test/event-errors-smoke.py` 会通过本地协议回放，验证实际 ZCode 适配器收到对象形式的错误后，界面仍能显示错误并继续下一轮对话。


## 每个模型独立的思考强度

按 **F4** 或输入 **`/effort`**，用 ↑↓ 选择、Enter 确认。状态栏显示当前选择。
`/effort low`、`/effort max` 可直接设置，`/effort default` 恢复原生默认。

- 档位保留原始 ID：`xhigh` 显示“极高”，`max` 显示“最高”，两者不会互相替换。
- Codex 从本机 `model/list` 读取当前型号的能力；DSH、Kimi、ZCode 从当前原生会话读取。Claude 使用型号对应的文档规则，界面会标明能力来源。
- 可选范围属于“模型 + 提供商 + 客户端”。同名模型换成另一 API 来源后，也可能只有开关或仅原生默认；不为它虚构低、中、高档位。
- 每个来源和模型分别保存在 `~/.habor/reasoning.json`，切换模型后恢复各自设置，不把另一个模型的最高档带过来。
- 不支持的已保存档位会报明原因并要求重新选择，不静默降档。调整在下一条消息生效，并保留当前原生会话。
- `ultra` 等客户端扩展模式会保留其名称和说明。例如 Codex 的 Ultra 包含自动委派，不等同于其他模型的 `max`。

第三方模型可在 **F3 → 编辑提供商 → 选择执行 Agent → R** 中声明实际支持的档位（如 `low,high,max`）；留空自动识别。原生客户端本身不能表达的档位仍不可用。
不同模型的同名档位不代表相同的计算量或效果，参见 [Claude Code effort 说明](https://code.claude.com/docs/en/model-config#adjust-effort-level)、[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

测试：`node packages/cli/test/native-provider-http.mjs --all --reasoning` 使用本地模拟接口，检查五种真实客户端的强度 / 开关参数。

## 连接来源与原生 Agent 路由

日常用 **F2** 选择模型，列表会显示来源、真实模型 ID 和执行 Agent。
用 **F3** 或 `/providers` 添加或编辑连接：

- **本地客户端**：复用本机 Codex、Claude Code、Kimi Code、ZCode、DSH 的登录与配置，不要求另填 API Key；客户端未安装时标为“待安装”。
- **官方 API**：选择官方来源，地址与初始模型 ID 自动填写，输入自己的 Key。模型 ID 可以按账号实际可用的型号修改。
- **自定义提供商**：填写名称、Base URL、Key 和模型 ID（多个用逗号分隔），逐个确认执行 Agent 与接口协议。

最后一步用 ↑↓ 选择 **保存并使用某个模型**，立即将当前任务切到新来源，保留上下文和草稿；
也可选择 **仅保存配置**。更新当前来源的 Key 或地址后，下一次回复会重新连接。
上次使用的模型与来源保存在 `~/.habor/selection.json`，重启后自动恢复；F2 随时切换。
DeepSeek 官方连接在界面显示 **DeepSeek V4.1 Flash**，请求发送 `model: "deepseek-flash"`，
对应 [官方发布说明中的 API 名称](https://deepseek.com/news/deepseek-v4-1-flash/)；自定义提供商的模型 ID 按用户填写值发送。

模型名称只用于给出路由建议，保存的绑定才决定执行 Agent。`gpt-6-astra` 默认建议 Codex；
`claude-fable-5` / `fable-5` 默认建议 Claude Code；Kimi、GLM、DeepSeek 分别建议自己的原生 Agent。
不认识的模型名必须明确选择 Agent，不会自动落到另一个客户端。接口模型 ID 按填写的值发送，不会用界面标题代替。

| 执行 Agent | API 连接方式 |
|---|---|
| Codex | 原生 `codex app-server`，Responses API，模型和提供商都在创建任务时显式指定 |
| Claude Code | 本机 `claude --print`，Anthropic Messages API；单次启动配置覆盖本地旧的连接变量 |
| Kimi Code | 原生 ACP，`KIMI_MODEL_*` 临时模型配置，OpenAI Chat Completions / Anthropic Messages |
| ZCode | 原生 app-server，临时 runtimeModel，支持 OpenAI Chat Completions / Responses / Anthropic Messages |
| DeepSeek Harness | 原生 DSH Agent 内注册独立 API 连接，使用 DeepSeek / OpenAI Chat Completions 协议 |

同一个第三方网关可以给不同模型配置不同协议。仅支持 `/chat/completions` 的服务不能直接当作 Codex 的 `/responses` 使用；
需要网关支持对应协议与工具调用，模型名称本身不改变接口能力。
参见 [Codex 提供商配置](https://learn.chatgpt.com/docs/config-file/config-reference)、
[Claude Code 单次配置优先级](https://code.claude.com/docs/en/settings)、
[Kimi 临时模型配置](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/env-vars.md)。

配置保存在 `~/.habor/providers.json`，Key 独立保存在当前用户可读写的 `~/.habor/credentials.json`（0600）。
输入界面隐藏 Key，Key 不进入模型列表、对话记录或命令参数；Claude 的单次连接配置写入权限为 0600 的临时文件，并在会话关闭时清理。
本地客户端的原有配置文件不会被这些 API 连接覆盖。

### 电脑没有安装 Agent

模型和 Agent 是两项依赖：API 提供模型推理，原生 Agent 执行文件操作、工具调用和任务。
当前 habor 需要安装所选模型绑定的 Agent；填写 API Key 不会安装客户端。

F2 保留所有已配置的模型，未检测到客户端时显示“待安装”。回车打开安装引导，
可以确认并自动安装官方 npm 客户端，或进入官方安装页。F3 保存 API 来源时若缺少 Agent，
会保留配置和 Key 并进入同一引导；当前任务和草稿保留，直到新连接成功启用。

**F5 / `/agents`** 管理 Agent，**`/login`** 管理当前 Agent 的认证：

- 自动安装支持 macOS / Linux 的 Codex、Claude Code、Kimi Code、DeepSeek Harness、Gemini CLI、Qwen Code；Grok Build 通过官方 shell 安装入口和原生终端管理。使用官方来源；安装前显示动作与目标目录。
- Codex / Claude / Kimi 使用官方 npm `latest`；DSH 自建桥接固定在已验证的 `0.1.0-rc.8`。实测 `0.1.5-rc.1` 虽可安装，但现有桥接无法完成 ACP 连接，因此暂不启用。Agent 程序版本和模型版本独立，兼容版本仍可调用 V4.1 Flash。
- DSH 显式安装已验证的 peer 依赖集合，再使用 `--legacy-peer-deps` 避开 npm 的循环 peer 解析；并非只跳过所需依赖。
- 包下载到 `~/.habor/agents/<adapter>/versions/<installation-id>`，通过包标识与可执行文件版本检查后，原子更新 `active.json`。失败或取消不会切换到半安装版本；旧版本留存。
- npm 使用 `~/.habor/npm-cache`，避免系统 npm 缓存的权限问题；不需要对原有 npm 目录执行 `sudo chown`。
- 优先级为用户显式指定的客户端路径、habor 托管版本、PATH 中的客户端。托管安装不改系统全局安装，不需要管理员权限，也无需重启。显式路径覆盖仍优先时界面会提示。
- Codex 提供浏览器登录与设备码；Claude 提供原生账号登录；Kimi 提供原生设备码；DSH 可打开 Web 配置；ZCode 可打开官方应用认证。
- 登录阶段临时将终端交给官方客户端。验证码、浏览器授权和输入由客户端处理，凭据由其保存与刷新；退出或 Ctrl+C 后恢复 habor 的界面和草稿。认证输出不进入任务历史。
- 官方 API Key 直接进入预填地址的隐藏输入表单；自定义来源可填写 URL、Key 和模型，并明确选择执行 Agent。已保存的 API 来源无需再进行订阅登录。
- 登录状态仅在原生客户端明确报告时显示“已认证”；安装成功、配置文件存在或启动桌面软件都不等于认证成功。账号额度与具体模型权限在连接时验证。
- Gemini CLI / Qwen Code 位于 F5 的 Agent 列表，提供自动安装、原生 `/auth` 配置与明确标注的“独立会话”入口。它们暂不出现在 F2 的 habor 会话路由中；原任务文本和草稿不会自动发送到外部终端，退出后回到原任务。

ZCode 没有在本项目中核实可用于自动安装的官方 npm 分发，继续提供官方桌面安装入口。
Windows 原生自动安装尚未实现，可使用 WSL 或官方安装页。外部安装改变 PATH 后需重启 habor；`/refresh` 可重新检测当前环境。

官方安装说明：[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、
[Claude Code](https://code.claude.com/docs/en/setup)、
[Kimi Code CLI](https://moonshotai.github.io/kimi-code/en/guides/getting-started)、
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、
[ZCode](https://zcode.z.ai/cn/docs/install)。

ZCode 默认检测 macOS 的 `/Applications` 和 `~/Applications`。
其他安装位置或系统需通过 `ZCODE_CLI` 指向应用内的 `zcode.cjs`；不会把无效的自定义路径静默替换成其他安装。

主流模型、官方 Agent、认证方式及接入边界见 [2026-09 模型与 Agent 清单](docs/model-agent-catalog-2026-09.md)。

### 模型不一致与连接错误

本地 DSH 会复用其保存的提供商配置，因此“DeepSeek 模型”不等于“DeepSeek 官方 API”。
“本机客户端”指在电脑上运行 Agent，仍通过 DSH 配置的 API 调用模型。
DSH 的本机凭据与 habor 的 API 来源 Key 分别保存；若提示 `DSH_CREDENTIAL_MISSING`，
运行 `dsh web`，在 Models 页面为错误中指定的来源填写 Key，或用 F2 选择已配置的 habor API 来源。
建立会话后会显示实际提供商与服务域名。
当上游返回 `InvalidSubscription` 时，界面会明确提示该 API 来源的订阅无效或已过期；
这类错误需要在对应服务处理，或通过 F3 添加有效连接并选择“保存并使用”。
ACP 的 `data.details` 会作为具体错误原因显示，不再丢成笼统的 `Internal error`。
`pnpm test:dsh-local` 使用隔离的 DSH 本地配置、凭据和模拟 API，覆盖订阅失败、来源显示和下一轮恢复。

原先显示 `GPT-5.5` 却加载 `gpt-6-astra`，是因为没有把界面模型转换为真实 ID 并传给执行客户端。
现在 Codex 直接使用本机客户端，并核对原生服务返回的模型 ID；不一致时会停止发送，显示明确错误。
Claude Code 使用显式 `--model`；API 模式还覆盖用户配置中可能残留的旧 Base URL、认证和模型变量。

`pnpm test` 覆盖配置保存、Key 隐藏、路由绑定、输入与错误恢复；
已安装 Codex 和 Claude Code 的机器还可以运行 `pnpm test:native`，通过本地模拟 API 验证两个**真实原生客户端**发送的模型 ID、地址、Key 和流式响应。
后者使用测试 Key 与本地 HTTP 服务；传入 `--all`（`node packages/cli/test/native-provider-http.mjs --all`）还会检查 Kimi、ZCode 和 DSH。

## 核心差异化：State 层 + Task/Session 亲和性

Agent Hub（acp-agent-hub / EchoBird / cc-switch 等）只管"连得上"；本平台统一管理**任务级状态**：

- **Task**：跨 harness 切换保持不变的持久单位
- **SessionBinding**：任务 ↔ (harness session) 的绑定链，记录每次切换（`new` / `switch`）
- **Conversation**：跨 harness 的统一对话记录，切换不丢
- **ContextSnapshot**：切换时的上下文快照（供新 harness 接续）
- **Workspace / Artifact / Checkpoint**：产物与回滚点

**亲和性规则（产品核心）**：

```
Task #1024 ──► DeepSeek Session abc ──► workspace/project-a ──► 快照 #7
用户切到 Claude：
Task #1024 ──► Claude Session xyz（任务还是同一个）

「继续刚才的任务」永远命中原 session 绑定，Router 不重新判路由；
只有用户显式 /model 切换或新建任务才产生新绑定。
```

## 仓库结构

```
packages/
├── core/       # 契约层：Agent/Session/Event/Permission 统一类型
├── router/     # ★ 路由层（独立子项目）：MODEL_CATALOG（模型→harness）/ Registry / TaskStore（State 层）/ TaskRouter（亲和性路由+任务简报）
├── adapters/   # 传输层：ACP client 框架 + ZCode Protocol + 各家 spec（注入给路由层）
├── cli/        # habor：终端客户端（模型选择器 / 任务 / 会话 / 流式 markdown 渲染）
└── dsh-acp/    # DeepSeek Harness 的 ACP server（in-process 引导）
```

依赖方向：`cli → router ← adapters`；`router → core`；`adapters → core`。
路由层不感知具体 harness，只通过 `Adapter` 接口工作；接入新 agent = 写 spec + 在 `MODEL_CATALOG` 登记。

## 已接入的原生 harness（本机实测）

| 用户可见模型 | 内部 harness | 传输 | 入口（实测） |
|---|---|---|---|
| DeepSeek V4 Flash / Pro | DeepSeek Harness | **ACP（自建 dsh-acp）** | `packages/dsh-acp`：in-process 引导 DSH + 标准 ACP server |
| GLM-5.3 | ZCode | **ZCode Protocol 流式** | 自建 client（session/create → subscribe → send → 事件流），真流式 + 多轮记忆 |
| Kimi K3 | Kimi Code | ACP | `kimi acp` |
| Claude Sonnet 4.6 / Fable 5 | Claude Code | 原生 stream-json | 本机 `claude --print --model ...` |
| GPT-5.5 / GPT-6 Astra | Codex | 原生 app-server | 本机 `codex app-server`，显式 model + provider |

认证：订阅/OAuth 登录自动复用（macOS Keychain / `~/.codex/auth.json` 等），本地无需 API key。

### dsh-acp：DeepSeek Harness 的 ACP server（已实现）

`packages/dsh-acp` 让 DeepSeek 模型以标准 ACP server 形态暴露原生 DSH 运行时：

- **in-process 引导**：createRequire 定位本机 dsh 安装，组合 dsh-base + code-runtime 挂载核心树
- **多轮会话**：一个 DSH Agent 跨 prompt 存活（真正的会话记忆）
- **事件流**：`assistant/chunk` → `agent_message_chunk`、`tool/call` → `tool_call`、`tool/result` → `tool_call_update`、usage → `usage_update`
- **审批桥**：DSH `approval/request` waterfall → ACP `requestPermission`（allow/reject）
- 任何 ACP client 可用：本项目的 habor、OpenHands Agent Canvas（Custom ACP server）、acp-agent-hub、Zed、JetBrains

## 接入新的 agent（声明式，~30 行）

```ts
// 方式一：CLI 子进程（一次性）
const mySpec: CliAgentSpec = {
  id: "my-harness",
  harnessName: "My Harness",
  models: ["My Model"],
  collectText: true,
  buildCommand: ({ prompt, cwd }) => ({ cmd: "my-cli", argv: ["--run", prompt, "--cwd", cwd] }),
  onExit: ({ exitCode, stderr }, emit) => { /* 错误兜底 */ }
};
// 方式二：ACP server（多轮会话）
const myAcp: AcpAgentSpec = {
  id: "my-acp",
  harnessName: "My Harness (ACP)",
  models: ["My Model"],
  command: () => ({ cmd: "my-cli", argv: ["acp"] })
};
// 然后在 core/registry.ts 的 MODEL_CATALOG 登记「用户可见模型 → adapterId」
```

## Roadmap

- [x] core（Session/Registry/Event/Workspace 雏形）
- [x] CLI 路由层（模型选择器 + 任务 + 亲和性 + 状态持久化）
- [x] ACP 传输层（多轮会话 + 权限桥接）
- [x] ZCode Protocol 流式 adapter（app-server 双向 JSON-RPC，text_delta 流式 + 多轮记忆）
- [x] Claude Code 风格渲染（流式 markdown：加粗/代码/列表/代码块 + 工具调用样式 + 推理斜体）
- [x] **dsh-acp**：DeepSeek Harness 的 ACP server（in-process 引导 DSH + 标准 ACP 协议，实测多轮/工具/流式全通）
- [ ] Router-as-ACP-Server：对外暴露为单个 ACP agent，可直接接入 OpenHands Agent Canvas / acp-agent-hub / Zed
- [ ] Workspace 文件系统能力（ACP fs 协议）+ 上下文压缩/摘要（ContextSnapshot 的 LLM 化）
- [ ] Checkpoint 落 git（worktree 隔离 + 可回滚）
- [ ] IDE 层（复用 Agent Core 的图形界面）
