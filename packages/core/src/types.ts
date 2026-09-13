/**
 * core/types.ts — 统一 Agent 事件与接口模型。
 *
 * 设计原则（与用户蓝图一致）：
 * - 用户只看到「模型」；「agent/harness」是内部实现，永不暴露。
 * - 所有 adapter 的输出必须归一化为统一的 AgentEvent 流。
 * - Session 是跨轮次的抽象；v1 各家 CLI 为一次性执行时，adapter 负责
 *   自行维护上下文（例如回填历史），core 不感知。
 */

/** 统一事件类型（用户蓝图的 Event union 的完整版）。 */
import type { ApiConnection, SourceKind } from "./connections.js";
import type { ReasoningCapabilities } from "./reasoning.js";

export type AgentEventType =
  | "connection"   // 实际执行来源的公开元数据，不包含凭据
  | "message"      // 助手文本（整段或增量）
  | "thinking"     // 推理过程
  | "tool_call"    // 工具调用
  | "tool_result"  // 工具结果
  | "file_change"  // 文件变更
  | "terminal"     // 终端/命令输出
  | "permission"   // 审批/确认请求
  | "usage"        // token / 成本统计
  | "error"
  | "done";

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultInfo {
  id: string;
  name: string;
  output: string;
  isError?: boolean;
  /** Partial tool updates remain running until the transport reports completion. */
  status?: "running" | "done" | "error";
}

export interface FileChangeInfo {
  path: string;
  type: "write" | "edit" | "delete";
  added?: number;
  removed?: number;
}

export interface TerminalInfo {
  command?: string;
  output?: string;
}

export interface PermissionInfo {
  id: string;
  toolName?: string;
  description: string;
  options?: string[];
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  /** 供应商给出的原始 usage（各 harness 不同） */
  raw?: unknown;
}

/** 一个统一的 agent 事件。 */
export interface AgentEvent {
  type: AgentEventType;
  ts: number;
  sessionId: string;
  adapterId: string;
  model: string;
  connection?: { agent: string; providerId: string; providerName: string; modelId: string; endpointHost?: string; sourceKind: SourceKind };
  text?: string;          // message 全文（accumulated）
  delta?: string;         // message 流式增量
  thinking?: string;      // thinking 文本
  tool?: ToolCallInfo;
  toolResult?: ToolResultInfo;
  file?: FileChangeInfo;
  terminal?: TerminalInfo;
  permission?: PermissionInfo;
  usage?: UsageInfo;
  error?: { message: string; code?: string };
}

/** 一次会话（对应某模型在对应原生 harness 里的一次运行）。 */
export interface Session {
  readonly id: string;
  /** 内部 harness id（用户不可见） */
  readonly adapterId: string;
  /** 用户可见的模型名 */
  readonly model: string;
  readonly cwd: string;
  /** 提交一条 prompt，返回归一化事件流 */
  prompt(input: string): AsyncIterable<AgentEvent>;
  /** 取消当前进行中的执行 */
  cancel(): Promise<void>;
  /** 关闭/释放会话 */
  close(): Promise<void>;
  getReasoningCapabilities?(): Promise<ReasoningCapabilities>;
  setReasoningEffort?(effort: string | undefined): Promise<void>;
}

/** 统一审批请求（ACP requestPermission 的归一化形态）。 */
export interface PermissionRequest {
  id: string;
  toolName: string;
  description: string;
  options: { id: string; name: string }[];
}

/** 统一审批决定。 */
export type PermissionDecision =
  | { allow: true; optionId?: string }
  | { allow: false; message?: string };

/** 会话创建选项。 */
export interface SessionOptions {
  model: string;
  /** Exact wire identifier; model is the user-facing selection label. */
  modelId?: string;
  connection?: ApiConnection;
  reasoningEffort?: string;
  /** Provider-declared supported wire values, scoped to this exact model/source. */
  reasoningLevels?: string[];
  cwd: string;
  /** 权限模式（各 harness 语义不同，adapter 自行映射） */
  permission?: "ask" | "auto";
  /** 内部回调：可用于注入历史上下文等 */
  context?: unknown;
  /** ask 模式下的人机审批回调（由 CLI/IDE 提供） */
  onPermission?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

/** 一个 adapter = 一个原生 harness 的接入实现。 */
export interface Adapter {
  /** 内部 id：dsh / zcode / kimi / claude / codex */
  readonly id: string;
  /** 内部 harness 名（用户不可见，仅日志/调试用） */
  readonly harnessName: string;
  /** 该 adapter 能服务的用户可见模型名 */
  readonly models: string[];
  /** CLI 是否可用（本机是否安装/可调用） */
  isAvailable(): Promise<boolean>;
  createSession(opts: SessionOptions): Promise<Session>;
}

/** 用户可见的模型目录条目。 */
export interface ModelEntry {
  /** 用户可见的模型名（CLI 里只显示这个） */
  model: string;
  modelId?: string;
  sourceKind?: SourceKind;
  providerId?: string;
  reasoningLevels?: string[];
  /** 该模型对应的内部 harness id */
  adapterId: string;
  vendor: string;
  /** 展示用的一句话描述 */
  display?: string;
}
