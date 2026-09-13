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

```sh
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
| 发送消息 | Enter |
| 插入换行 | Alt+Enter / Ctrl+J；支持相应键盘协议的终端也可用 Shift+Enter |
| 编辑输入 | ← →、Home / End、Ctrl+A / E、Ctrl+U / K / W |
| 历史输入 / 多行移动 | ↑ ↓（在多行输入边界进入历史） |
| 浏览对话 | PgUp / PgDn、Shift+↑↓、滚轮；Esc 回到底部 |
| 展开思考与完整工具输出 | Ctrl+O |
| 复制最近一段回复 | Ctrl+Y |
| 清空屏幕，保留任务 | Ctrl+L / `/clear` |
| 停止当前回复 | Esc / Ctrl+C（命令菜单打开时 Esc 先收起菜单） |
| 退出 | `/quit`；空草稿下连按两次 Ctrl+C |

运行时可以继续编辑下一条草稿，回复结束后按 Enter 发送。粘贴多行内容不会自动发送。
停止回复后保留当前任务和已收到的回答，后续输入会在同一模型上重建连接并带入任务上下文。
工具结果按调用 ID 匹配；思考与长输出默认折叠，输入/输出 token 数放在状态栏。
鼠标选择文字时可按住 Shift（具体行为取决于终端设置）。

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

- **本地客户端**：复用本机 Codex、Claude Code、Kimi Code、ZCode、DSH 的登录与配置，不要求另填 API Key；客户端未安装时不会显示为可用。
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

### 模型不一致与连接错误

本地 DSH 会复用其保存的提供商配置，因此“DeepSeek 模型”不等于“DeepSeek 官方 API”。
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
