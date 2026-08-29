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
import { runCli } from "./base.js";

/** 一个原生 harness 的 ACP 接入规格。 */
export interface AcpAgentSpec {
  id: string;
  harnessName: string;
  models: string[];
  /** 启动该 harness 的 ACP server 子进程 */
  command(ctx: { model: string }): { cmd: string; argv: string[]; env?: NodeJS.ProcessEnv };
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
      const r = await runCli({ cmd: "sh", argv: ["-lc", `command -v ${JSON.stringify(cmd)}`], timeoutMs: 10000 });
      return r.exitCode === 0;
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
      const { cmd, argv, env } = this.spec.command({ model: this.opts.model });
      const proc = spawn(cmd, argv, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
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
          resolveConnect(true);
          await releasedPromise; // 保活：直到 close()
        })
        .catch((err) => {
          this.active = null;
          rejectConnect(err instanceof Error ? err : new Error(String(err)));
        });
    });
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
          input: (update as any).content ?? {}
        }
      });
    } else if (u === "tool_call_update") {
      emit({
        type: "tool_result",
        toolResult: {
          id: update.toolCallId ?? "t",
          name: "tool",
          output: JSON.stringify((update as any).content ?? {}),
          isError: update.status === "failed"
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
      error: { message: err instanceof Error ? err.message : String(err) },
      ...base,
      ts: Date.now()
    });

    let session: acp.ActiveSession | null;
    try {
      await this.ensureConnected();
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
