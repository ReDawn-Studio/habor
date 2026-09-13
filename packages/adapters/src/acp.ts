/**
 * adapters/acp.ts — ACP 传输层。
 *
 * 架构对齐：Agent Core（Session/Workspace/Registry/Permission/Event Stream）
 * 通过 ACP（Agent Client Protocol，JSON-RPC 2.0 over stdio）连接各原生 harness
 * 的 ACP server。本文件是「ACP client」端实现：
 *
 *   - 多轮会话：一个 ActiveSession 跨多次 prompt() 复用（真正的会话连续性）
 *   - Permission：agent 的 requestPermission → 归一化为 core 的 onPermission
 *   - Event Stream：agent_message_chunk / tool_call / usage 等 → 统一 AgentEvent
 *
 * 各家 ACP server 入口（spec 决定）：
 *   - kimi：`kimi acp`（官方原生）
 *   - claude：`npx @agentclientprotocol/claude-agent-acp`（官方包装）
 *   - codex：`npx @zed-industries/codex-acp`（Zed 官方包装）
 *   - dsh：需要自建 dsh-acp（下一步）
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  Adapter,
  AgentEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionOptions
} from "@agent-router/core";
import { hasCommand } from "./base.js";
import { describeAgentError, reasoningLabel, assertReasoningLevel, type ReasoningCapabilities } from "@agent-router/core";

/** 一个原生 harness 的 ACP 接入规格。 */
export interface AcpAgentSpec {
  id: string;
  harnessName: string;
  models: string[];
  /** 启动该 harness 的 ACP server 子进程 */
  command(ctx: { model: string; modelId?: string; connection?: SessionOptions["connection"]; reasoningEffort?: string }): { cmd: string; argv: string[]; env?: NodeJS.ProcessEnv };
  /** 本机可用性检查 */
  isAvailable?(): Promise<boolean>;
  /** 是否后台保活（false 时每次 prompt 新建进程；默认 true 保活多轮） */
  keepAlive?: boolean;
}

export function createAcpAdapter(spec: AcpAgentSpec): Adapter {
  return {
    id: spec.id,
    harnessName: spec.harnessName,
    models: spec.models,
    isAvailable: async () => {
      if (spec.isAvailable) return spec.isAvailable();
      const { cmd } = spec.command({ model: spec.models[0] ?? "" });
      return hasCommand(cmd);
    },
    createSession: async (opts: SessionOptions) => new AcpSession(spec, opts)
  };
}

class AcpSession implements Session {
  readonly id: string;
  readonly adapterId: string;

  private proc: ChildProcess | null = null;
  private conn: Promise<boolean> | null = null;
  private active: acp.ActiveSession | null = null;
  private client?: acp.ClientContext;
  private configOptions: any[] = [];
  private nativeReasoning?: ReasoningCapabilities;
  private defaultEffortValue?: string;
  private closed = false;
  private released: (() => void) | null = null;
  private pendingPermission: {
    req: acp.RequestPermissionRequest;
    resolve: (r: acp.RequestPermissionResponse) => void;
  } | null = null;

  constructor(
    private spec: AcpAgentSpec,
    readonly opts: SessionOptions
  ) {
    this.adapterId = spec.id;
    this.id = `${spec.id}-${randomUUID().slice(0, 8)}`;
  }

  get model(): string {
    return this.opts.model;
  }
  get cwd(): string {
    return this.opts.cwd;
  }

  /** 建立 ACP 连接 + 创建 session（惰性，首次 prompt 时）。失败可重试。 */
  private async ensureConnected(): Promise<void> {
    if (this.conn) {
      await this.conn;
      return;
    }
    this.conn = this.connect();
    try {
      await this.conn;
    } catch (err) {
      this.conn = null;
      throw err;
    }
  }

  private connect(): Promise<boolean> {
    return new Promise<boolean>((resolveConnect, rejectConnect) => {
      const { cmd, argv, env } = this.spec.command(this.opts);
      const proc = spawn(cmd, argv, { cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
      // Server diagnostics must not overwrite the terminal's managed screen.
      proc.stderr?.resume();
      this.proc = proc;
      proc.on("error", (err) => rejectConnect(err));

      const input = Writable.toWeb(proc.stdin!);
      const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);

      let releasedPromiseResolve: () => void;
      const releasedPromise = new Promise<void>((r) => (releasedPromiseResolve = r));
      this.released = releasedPromiseResolve!;

      const onPermission = async (
        req: acp.RequestPermissionRequest
      ): Promise<acp.RequestPermissionResponse> => {
        const auto = this.opts.permission !== "ask" || !this.opts.onPermission;
        if (auto) {
          const opt = req.options[0];
          if (!opt) return { outcome: { outcome: "denied" } as never };
          return { outcome: { outcome: "selected", optionId: opt.optionId } };
        }
        // ask 模式：挂起，等 prompt 循环里调用 onPermission 后回填
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          this.pendingPermission = { req, resolve };
        });
      };

      acp
        .client({ name: "agent-router" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => onPermission(ctx.params))
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {}
          });
          const active = await ctx.buildSession(this.opts.cwd).start();
          this.active = active;
          this.client = ctx;
          this.configOptions = active.newSessionResponse.configOptions ?? [];
          const modelOption = this.configOptions.find(option => option.category === "model");
          if (!this.opts.connection && modelOption && modelOption.currentValue !== this.opts.modelId && modelOption.options?.some((option: any) => option.value === this.opts.modelId)) {
            const updated = await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId: active.sessionId, configId: modelOption.id, value: this.opts.modelId! }) as { configOptions: any[] };
            this.configOptions = updated.configOptions;
          }
          const thought = this.thoughtOption();
          this.defaultEffortValue = thought?.options?.some((option: any) => option.value === "default") ? "default" : thought?.currentValue;
          this.nativeReasoning = active.newSessionResponse._meta?.haborReasoning as ReasoningCapabilities | undefined;
          resolveConnect(true);
          await releasedPromise; // 保活：直到 close()
        })
        .catch((err) => {
          this.active = null;
          rejectConnect(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private thoughtOption(): any { return this.configOptions.find(option => option.category === "thought_level"); }
  private reasoningCapabilities(): ReasoningCapabilities {
    const option = this.thoughtOption();
    const flatten = (options: any[]): any[] => options.flatMap(item => Array.isArray(item.options) ? flatten(item.options) : [item]);
    const capabilities: ReasoningCapabilities = this.nativeReasoning ?? { source: option ? "native" : "unknown", defaultId: this.defaultEffortValue,
      levels: flatten(option?.options ?? []).filter(item => typeof item.value === "string" && item.value !== "default" && item.value !== "auto").map(item => ({ id: item.value, label: reasoningLabel(item.value), description: item.description })) };
    return this.opts.reasoningLevels ? { ...capabilities, source: "configured", levels: capabilities.levels.filter(level => this.opts.reasoningLevels!.includes(level.id)) } : capabilities;
  }
  async getReasoningCapabilities(): Promise<ReasoningCapabilities> { await this.ensureConnected(); return this.reasoningCapabilities(); }
  private async applyReasoning(effort?: string): Promise<void> {
    assertReasoningLevel(this.reasoningCapabilities(), effort);
    const option = this.thoughtOption();
    if (!option || !this.active || !this.client) return;
    const value = effort ?? this.defaultEffortValue;
    if (value === undefined) return;
    const updated = await this.client.request(acp.methods.agent.session.setConfigOption, { sessionId: this.active.sessionId, configId: option.id, value }) as { configOptions: any[] };
    this.configOptions = updated.configOptions;
    const applied = this.thoughtOption()?.currentValue;
    if (applied !== value) throw new Error(`原生客户端将思考强度设为 ${applied ?? "未知"}，未接受 ${value}；请重新选择可用档位`);
  }
  async setReasoningEffort(effort: string | undefined): Promise<void> {
    await this.ensureConnected(); await this.applyReasoning(effort); this.opts.reasoningEffort = effort;
  }

  private toPermissionRequest(req: acp.RequestPermissionRequest): PermissionRequest {
    return {
      id: req.sessionId + ":" + (req.toolCall?.toolCallId ?? randomUUID()),
      toolName: req.toolCall?.title ?? req.toolCall?.status ?? "tool",
      description: req.toolCall?.title ?? "需要确认的操作",
      options: (req.options ?? []).map((o) => ({ id: o.optionId, name: o.name }))
    };
  }

  private mapUpdate(
    update: acp.SessionUpdate,
    emit: (ev: Omit<AgentEvent, "ts" | "sessionId" | "adapterId" | "model">) => void
  ): void {
    const u = update.sessionUpdate;
    if (u === "agent_message_chunk" && update.content?.type === "text") {
      emit({ type: "message", delta: update.content.text ?? "" });
    } else if (u === "agent_thought_chunk") {
      const t = (update as any).content?.text ?? (update as any).content?.thought ?? "";
      if (t) emit({ type: "thinking", thinking: t });
    } else if (u === "tool_call") {
      emit({
        type: "tool_call",
        tool: {
          id: update.toolCallId ?? "t",
          name: update.title ?? "tool",
          input: (update as any).rawInput ?? (update as any).content ?? {}
        }
      });
    } else if (u === "tool_call_update") {
      emit({
        type: "tool_result",
        toolResult: {
          id: update.toolCallId ?? "t",
          name: "tool",
          output: ((update as any).content ?? []).map((item: any) => {
            if (item.type === "content" && item.content?.type === "text") return item.content.text ?? "";
            if (item.type === "text") return item.text ?? "";
            if (item.type === "diff") return `修改 ${item.path ?? "文件"}`;
            return "";
          }).filter(Boolean).join("\n"),
          isError: update.status === "failed",
          status: update.status === "failed" ? "error" : update.status === "completed" ? "done" : "running"
        }
      });
    } else if (u === "usage_update") {
      const usage = (update as any).usage ?? {};
      emit({
        type: "usage",
        usage: {
          inputTokens: usage.inputTokens ?? usage.input_tokens,
          outputTokens: usage.outputTokens ?? usage.output_tokens,
          totalTokens: usage.totalTokens ?? usage.total,
          raw: usage
        }
      });
    }
  }

  async *prompt(input: string): AsyncIterable<AgentEvent> {
    const base = { sessionId: this.id, adapterId: this.spec.id, model: this.opts.model };
    const fail = (err: unknown) => ({
      type: "error" as const,
      error: describeAgentError(err, [this.opts.connection?.apiKey ?? ""]),
      ...base,
      ts: Date.now()
    });

    let session: acp.ActiveSession | null;
    try {
      await this.ensureConnected();
      if (this.opts.reasoningEffort !== undefined) await this.applyReasoning(this.opts.reasoningEffort);
    } catch (err) {
      yield fail(err);
      yield { type: "done" as const, ...base, ts: Date.now() };
      return;
    }
    session = this.active;
    if (!session) {
      yield fail(new Error(`ACP 会话不可用（${this.spec.harnessName}）`));
      yield { type: "done" as const, ...base, ts: Date.now() };
      return;
    }
    const connection = session.newSessionResponse._meta?.haborConnection as AgentEvent["connection"] | undefined;
    if (connection && typeof connection.providerId === "string" && typeof connection.modelId === "string") {
      yield { type: "connection", connection, ...base, ts: Date.now() };
    }

    // 每轮 prompt 开始前，若上一轮遗留挂起的审批，先按 auto 兜底
    type Pending = NonNullable<AcpSession["pendingPermission"]>;
    const stale = this.pendingPermission as Pending | null;
    if (stale) {
      this.pendingPermission = null;
      stale.resolve({
        outcome: { outcome: "selected", optionId: stale.req.options[0]?.optionId ?? ("" as never) }
      });
    }

    // prompt 的错误通过 catch 捕获，避免 unhandledRejection 崩进程
    let promptError: unknown = null;
    const promptPromise = session.prompt(input);
    promptPromise.catch((err) => {
      promptError = err;
    });

    for (;;) {
      // 处理挂起的审批请求（ask 模式）
      const pending = this.pendingPermission as Pending | null;
      if (pending) {
        this.pendingPermission = null;
        const decision: PermissionDecision = this.opts.onPermission
          ? await this.opts.onPermission(this.toPermissionRequest(pending.req))
          : { allow: true, optionId: pending.req.options[0]?.optionId };
        if (decision.allow) {
          pending.resolve({
            outcome: {
              outcome: "selected",
              optionId: decision.optionId ?? pending.req.options[0]?.optionId ?? ("" as never)
            }
          });
        } else {
          pending.resolve({ outcome: { outcome: "denied" } as never });
        }
      }

      let msg: acp.ActiveSessionMessage;
      try {
        msg = await session.nextUpdate();
      } catch (err) {
        promptError = err;
        break;
      }
      if (msg.kind === "stop") break;
      const emitted: Omit<AgentEvent, "ts" | "sessionId" | "adapterId" | "model">[] = [];
      this.mapUpdate(msg.notification.update, (ev) => emitted.push(ev));
      for (const ev of emitted) {
        yield {
          ...ev,
          ts: Date.now(),
          sessionId: this.id,
          adapterId: this.spec.id,
          model: this.opts.model
        } as AgentEvent;
      }
    }

    if (promptError) {
      yield fail(promptError);
    }
    yield { type: "done" as const, ...base, ts: Date.now() };
  }

  cancel(): Promise<void> {
    // 简化：kill 连接进程即中止当前轮
    if (this.proc) this.proc.kill("SIGKILL");
    return Promise.resolve();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.released?.();
    this.active?.dispose();
    if (this.proc) {
      this.proc.kill("SIGTERM");
      setTimeout(() => this.proc?.kill("SIGKILL"), 2000).unref();
    }
  }
}
