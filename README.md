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
├── core/       # Agent Core：types / Registry（模型→harness）/ TaskStore（State 层）/ TaskRouter（亲和性路由）
├── adapters/   # 传输层：通用子进程框架 + ACP client 框架 + 各家 spec
└── cli/        # habor：终端客户端（模型选择器 / 任务 / 会话 / 事件流渲染）
```

## 已接入的原生 harness（本机实测）

| 用户可见模型 | 内部 harness | 传输 | 入口（实测） |
|---|---|---|---|
| DeepSeek V4 Flash / Pro | DeepSeek Harness | **ACP（自建 dsh-acp）** | `packages/dsh-acp`：in-process 引导 DSH + 标准 ACP server |
| GLM-5.3 | ZCode | **ZCode Protocol 流式** | 自建 client（session/create → subscribe → send → 事件流），真流式 + 多轮记忆 |
| Kimi K3 | Kimi Code | ACP | `kimi acp` |
| Claude Sonnet 4.6 | Claude Code | ACP | `npx @agentclientprotocol/claude-agent-acp` |
| GPT-5.5 | Codex | ACP | `npx @zed-industries/codex-acp` |

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
