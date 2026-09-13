# 主流模型与官方 Agent：安装、认证和 habor 接入

核实日期：**2026-09-14**。范围是通用推理、编程和工具执行模型；不把图像、语音、视频生成产品都当作编程 Agent。
表中的“当前主力”来自当日可获取的官方模型页，不代表每个账号、地区、订阅或第三方网关都可访问。
运行时实际模型列表、协议能力、登录状态和权限应以所选客户端及提供商返回为准。

| 厂商 | 当前主力型号 / API ID | 官方 CLI 或软件 | 安装与认证 | habor v0.5 接入状态 |
|---|---|---|---|---|
| OpenAI | GPT-6 Astra / `gpt-6-astra`；GPT-5.6 Sol / Terra / Luna | Codex CLI、Codex 应用 | `@openai/codex`；ChatGPT 浏览器授权、设备码或 API Key | 原生 app-server 会话；托管 npm 安装、浏览器 / 设备码登录、API 来源 |
| Anthropic | Claude Fable 5.1 / `claude-fable-5-1`；Opus 5、Sonnet 5 | Claude Code、Claude Desktop 的 Code 功能 | `@anthropic-ai/claude-code` 或官方原生安装器；账号授权或 API Key | 原生流式会话；托管 npm 安装、原生登录、API 来源 |
| DeepSeek | V4.1 Flash / `deepseek-flash` | DeepSeek Harness（DSH） | `@deepseek-ai/dsh@0.1.0-rc.8`（桥接兼容版本）；原生提供商 Key 或 habor API Key | 原生 DSH + ACP；托管安装、Web 原生配置、API 来源 |
| Google | Gemini 3.8 Flash / `gemini-3.8-flash`；3.1 Pro Preview | Gemini CLI；另有云端 Antigravity Agent 产品 | `@google/gemini-cli`；Google 登录、Gemini API Key、Vertex AI | F5 支持托管安装、原生认证与独立终端；尚未接入 habor 的统一消息流和任务上下文 |
| Alibaba / Qwen | Qwen3.8-Max-0902 / `qwen3.8-max-0902`、Qwen3.8 Flash；编码专用 Qwen3-Coder-Next | Qwen Code | `@qwen-code/qwen-code`；ModelStudio Coding Plan / Token Plan / API Key、自定义提供商 | F5 支持托管安装、原生 `/auth` 与独立终端；尚未接入 habor 的统一消息流和任务上下文 |
| Moonshot | Kimi K3；API 与 Code 别名需按来源分别核对 | Kimi Code CLI、IDE 集成 | `@moonshot-ai/kimi-code`；设备码 OAuth 或 API Key | 原生 ACP；托管安装、设备码登录、API 来源 |
| Z.ai / 智谱 | GLM-5.3、GLM-5.3-Flash | ZCode 桌面应用，内置 ZCode Agent | 官方桌面安装程序；Z.ai / BigModel 账号与 Coding Plan，或 API Key | 已接入本机 ZCode app-server；提供软件与认证入口，未伪造 npm 安装方式 |
| MiniMax | MiniMax M3 / `MiniMax-M3` | MiniMax Code / MiniMax Agent 桌面与网页产品 | 官方软件下载与账号、Token Plan / API 接入 | 软件存在；本次未核实足够稳定的公开本地控制协议与官方 npm CLI，未宣称原生会话接入 |
| xAI | Grok 4.6 / `grok-4.6` | Grok 应用、网页与 API | 官方账号或 API Key | 本次未核实可直接作为本地编程 harness 的官方 CLI；第三方同名 CLI 不标为官方 |

## 官方依据

- OpenAI：[当前模型](https://developers.openai.com/api/docs/models)、[Codex CLI 安装](https://learn.chatgpt.com/docs/codex/cli)、[认证与设备码](https://learn.chatgpt.com/docs/auth)。
- Anthropic：[Fable 5.1 与当前产品线](https://platform.claude.com/docs/en/models/fable-5-1/overview)、[Claude Code 安装](https://code.claude.com/docs/en/setup)、[原生认证命令](https://code.claude.com/docs/en/cli-reference)、[凭据与认证优先级](https://code.claude.com/docs/en/team)。
- DeepSeek：[V4.1 Flash 发布及 API 名称](https://www.deepseek.com/news/deepseek-v4-1-flash/)、[官方 Harness 源码与分发](https://github.com/deepseek-ai/deepseek-harness)。`deepseek-flash` 是官方 API 名称；模型版本名不应直接当作接口 ID。
- Google：[当前模型与 ID](https://ai.google.dev/gemini-api/docs/models)、[Gemini CLI 安装](https://geminicli.com/docs/changelogs/latest/)、[认证选项](https://geminicli.com/docs/get-started/authentication/)。API 发布某个新型号，不等于每个 CLI 账号立刻获得该型号。
- Qwen：[Model Studio 模型更新](https://www.alibabacloud.com/help/en/model-studio/newly-released-models)、[Qwen Code 安装](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/)、[当前认证方式](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)。当前文档已移除 Qwen OAuth 菜单；旧教程中的免费 OAuth 流程不能继续作为默认。
- Kimi：[K3 与 Code](https://www.kimi.com/code/en)、[安装与认证](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started)、[login 子命令](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)。本机 CLI 的 `login --help` 还列出地区参数，表明本机版本帮助也是实现时需要核对的证据。
- ZCode：[官方 Agent](https://zcode.z.ai/en)、[安装程序](https://zcode.z.ai/cn/docs/install)、[连接模型及计划](https://zcode.z.ai/en/docs/configuration)。
- MiniMax：[M3 与 MiniMax Code](https://www.minimax.io/blog/minimax-m3)、[官方软件入口](https://www.minimax.io/)。
- xAI：[当前 Grok 模型](https://docs.x.ai/developers/models)。未发现接口不等于接口绝对不存在；应在适配前核实，而不是编造启动参数。

## 推荐的产品结构

模型、来源、Agent 和认证应当是四个独立对象：

1. **模型**：展示名称、真实 API ID、能力、更新日期。
2. **来源**：官方 API、第三方网关或原生客户端已配置的来源。
3. **Agent**：受信任的官方包或软件、安装版本、可执行文件、控制协议。
4. **认证**：原生账号授权，或按来源隔离的 API Key；不把“检测到程序”等同于“已登录”。

执行顺序是：选择模型与来源 → 检查 Agent → 展示并确认安装 → 选择认证方式 → 原生状态检查 → 建立会话 → 发起任务。
安装版本和协议支持必须有明确的验证结果。失败时保留已有任务和已配置 Key，不静默切到其他模型或 Agent。
本次实测 DSH npm 最新版本 `0.1.5-rc.1` 安装成功，但现有 ACP 桥接握手失败；因此自动安装策略固定到已验证的 `0.1.0-rc.8`。
这是 Agent 的协议兼容约束，不能据此把用户选择的 V4.1 Flash 模型降级。

## 登录消息如何管理

普通回复流主要是输出事件；认证可能是多轮交互，还涉及浏览器回调、设备码轮询、终端输入和刷新令牌。
因此“能读取聊天流”不足以证明“能代管登录”。

- **结构化认证接口优先**：客户端公开登录开始、完成、状态事件时，可以把 URL、设备码、过期时间和状态映射到 habor 临时面板。令牌仍由官方客户端存储与刷新。
- **原生终端接管作为兼容路径**：官方 `login` 命令可能要求真实 TTY；habor 暂停自身 raw mode，将同一个终端交给它，结束或取消后恢复。这是当前实现，涵盖已接入 CLI 的浏览器、设备码和输入交互，认证文本不加入对话历史。
- **桌面配置入口**：只有 GUI 的官方软件，通过其官方界面完成登录；在公开控制协议中验证会话，不能把“应用打开了”当作“授权成功”。
- **API Key 由 habor 管理**：适合官方 API 与第三方来源；隐藏输入、按来源隔离、传给对应原生 Agent。无需再绑定一个无关的订阅账号。

不要仿制厂商登录页面、解析私有浏览器 Cookie、导出刷新令牌，或把 OTP 与访问令牌混入聊天历史。

## 其他方案与取舍

| 方案 | 优点 | 代价 / 边界 |
|---|---|---|
| 原生 Agent + habor 管理安装认证（当前） | 保留厂商工具、记忆、技能、订阅与模型调优；统一入口 | 每个 Agent 的协议、版本和认证需要适配 |
| ACP / app-server / 官方 SDK | 标准化事件、取消、工具和权限；适合长期集成 | 并非每个软件实现同样的认证与模型选择能力 |
| 内置通用 Agent + 多家 API | 安装步骤少，工具和认证由 habor统一管理 | 需要自己实现文件操作、权限、会话、工具执行；不能声称具有原生 Agent 的相同行为；账号订阅通常不能替代 API 凭据 |
| GUI 自动化驱动厂商软件 | 可覆盖无公开协议的产品 | 易受 UI 更新影响，难以可靠管理权限和并发，不宜作为默认核心连接 |

当前实现针对已有五条原生会话链路完成生命周期管理，并为 Gemini / Qwen 提供原生独立终端入口；研究清单覆盖更广的厂商。
独立终端模式可安装、认证并在官方 CLI 中选择型号、执行任务，但不会自动继承 habor 的任务文本，也不把原生输出写成 habor 回复。
Gemini、Qwen 等应在验证其公开会话协议、模型选择、认证取消和工具权限之后，再标为“已接入统一会话”。
