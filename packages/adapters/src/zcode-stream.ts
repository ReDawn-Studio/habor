/**
 * adapters/zcode-stream.ts — ZCode 流式 adapter（ZCode Protocol）。
 *
 * ZCode 桌面端内置 `app-server`（ZCode Protocol，双向 JSON-RPC over stdio）：
 *   session/create（workspace）→ session/subscribe（事件订阅）→
 *   session/send（content: string）→ 服务端推送 session/event 事件流：
 *     text_delta / reasoning_delta / tool_call / complete / error
 *
 * 与一次性 `zcode --prompt` 不同：真流式 + 同一 session 跨多轮存活（多轮记忆）。
 * 服务端会主动发起 session/requestRuntimePreferences 请求，必须应答。
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, AgentEvent, Session, SessionOptions } from "@agent-router/core";
import { toDisplayText, assertReasoningLevel, reasoningLabel, type ReasoningCapabilities } from "@agent-router/core";

const ZCODE_MODELS = ["GLM-5.3"];

function resolveZcodeCli(): string | undefined {
  if (process.env.ZCODE_CLI && existsSync(process.env.ZCODE_CLI)) return process.env.ZCODE_CLI;
  const candidates = [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    join(homedir(), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")
  ];
  return candidates.find((p) => existsSync(p));
}

const cliPath = resolveZcodeCli();

/** 简易 JSON-RPC 行协议（ZCode Protocol 不接受 jsonrpc 字段）。 */
class ZcodeRpc {
  private pending = new Map<string | number, (m: any) => void>();
  private seq = 1;
  private closed = false;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (id: string | number, method: string, params: any) => void = () => {};

  constructor(
    private stdin: NodeJS.WritableStream,
    private stdout: NodeJS.ReadableStream
  ) {
    let buf = "";
    this.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        this.handleLine(line);
      }
    });
    const close = () => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) pending({ error: { message: "ZCode 连接已关闭，请重试" } });
      this.pending.clear();
    };
    this.stdout.on("end", close);
    this.stdin.on("error", close);
  }

  private handleLine(line: string): void {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method) {
      if (m.id !== undefined) {
        this.onRequest(m.id, m.method, m.params);
      } else {
        this.onNotification(m.method, m.params);
      }
    } else if (m.id !== undefined) {
      const cb = this.pending.get(m.id);
      if (cb) {
        this.pending.delete(m.id);
        cb(m);
      }
    }
  }

  request(method: string, params: any): Promise<any> {
    if (this.closed) return Promise.reject(new Error("ZCode 连接已关闭，请重试"));
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`zcode rpc timeout: ${method}`));
        }
      }, 60000);
      this.pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(toDisplayText(m.error))) : resolve(m.result); });
      this.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  respond(id: string | number, result: any): void {
    this.stdin.write(JSON.stringify({ id, result }) + "\n");
  }
}

class ZcodeSession implements Session {
  readonly id = `zcode-${randomUUID().slice(0, 8)}`;
  readonly adapterId = "zcode";
  private proc: ChildProcess | null = null;
  private rpc: ZcodeRpc | null = null;
  private sessionId: string | null = null;
  private connected: Promise<void> | null = null;
  private reasoning: ReasoningCapabilities = { levels: [], source: "unknown" };
  private defaultThoughtLevel?: string;

  constructor(
    readonly model: string,
    readonly cwd: string,
    readonly permission: "ask" | "auto",
    private opts?: SessionOptions
  ) {}

  private async connect(): Promise<void> {
    if (this.connected) return this.connected;
    this.connected = this.doConnect();
    try {
      await this.connected;
    } catch (err) {
      this.connected = null;
      throw err;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!cliPath) return reject(new Error("未找到 ZCode CLI（zcode.cjs）"));
      const proc = spawn(process.execPath, [cliPath, "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(this.opts?.connection ? { HABOR_PROVIDER_KEY: this.opts.connection.apiKey } : {}) } });
      this.proc = proc;
      proc.stderr.on("data", () => {
        /* 调试用：忽略 */
      });
      const rpc = new ZcodeRpc(proc.stdin, proc.stdout);
      this.rpc = rpc;

      rpc.onRequest = (id, method, params) => {
        if (method === "session/requestRuntimePreferences") {
          // 必须应答，否则 session/create 15s 超时；sessionId 在这里给出
          if (params?.sessionId) this.sessionId = params.sessionId;
          rpc.respond(id, { nativeSearchEnhancementsEnabled: false });
        } else if (method === "interaction/requestPermission") {
          // 工具权限请求：auto 模式自动允许
          rpc.respond(id, { decision: "allow" });
        } else if (method === "interaction/requestUserInput") {
          // 需要用户输入的问题：auto 模式给空/自动
          rpc.respond(id, { input: "", skip: true });
        } else {
          // 未知交互请求：尽力应答空对象，避免卡住
          rpc.respond(id, {});
        }
      };

      proc.on("exit", () => {
        this.proc = null;
        this.connected = null;
      });

      void (async () => {
        try {
          const workspaceKey = `habor-${this.id}`;
          let result = await rpc.request("session/create", {
            workspace: { workspacePath: this.cwd, workspaceKey },
            ...(this.runtimeModel() ? { runtimeModel: this.runtimeModel(), titleGenerationEnabled: false } : {})
          });
          this.sessionId ??= result?.snapshot?.session?.sessionId ?? result?.snapshot?.session?.id ?? result?.sessionId;
          // sessionId 由 requestRuntimePreferences 回调给出
          // 等 sessionId 就绪（create 过程中服务端会先发 requestRuntimePreferences）
          const deadline = Date.now() + 20000;
          while (!this.sessionId && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!this.sessionId) throw new Error("zcode: 未拿到 sessionId");
          const desired = this.opts?.modelId ?? "glm-5.3";
          const selection = result?.snapshot?.settings?.model ?? result?.settings?.model;
          const runtimeModel = this.runtimeModel();
          const ref = runtimeModel?.model ?? selection?.available?.find((item: any) => item.ref?.modelId?.toLowerCase() === desired.toLowerCase())?.ref;
          if (runtimeModel || selection?.current?.modelId?.toLowerCase() !== desired.toLowerCase()) {
            if (!ref) throw new Error(`ZCode 本地配置中没有 ${desired}，请在 /providers 添加 API 来源或在 ZCode 中配置该模型`);
            result = await rpc.request("session/setModel", { sessionId: this.sessionId, model: ref, ...(runtimeModel ? { runtimeModel } : {}), persistAsWorkspaceLastUsed: false });
          }
          const thought = result?.snapshot?.settings?.thoughtLevel ?? result?.settings?.thoughtLevel;
          this.defaultThoughtLevel = thought?.current ?? thought?.defaultLevel;
          this.reasoning = { source: thought ? "native" : "unknown", defaultId: this.defaultThoughtLevel,
            levels: (thought?.available ?? []).filter((level: any) => typeof level.value === "string" && (!this.opts?.reasoningLevels || this.opts.reasoningLevels.includes(level.value))).map((level: any) => ({ id: level.value, label: reasoningLabel(level.value), description: level.description })) };
          await rpc.request("session/subscribe", {
            sessionId: this.sessionId,
            deliveryKind: "web-remote-replayable"
          });
          // yolo = 自动批准工具（auto 权限）；ask 模式用 build（需处理 requestPermission）
          try {
            const modeRes = await rpc.request("session/setMode", {
              sessionId: this.sessionId,
              mode: this.permission === "ask" ? "build" : "yolo"
            });
          } catch (e) {
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      })();
    });
  }

  private runtimeModel(): any {
    const api = this.opts?.connection;
    if (!api) return undefined;
    const modelId = this.opts?.modelId ?? this.model;
    return {
      revision: `habor-${api.providerId}`, generatedAt: Date.now(), model: { providerId: api.providerId, modelId },
      provider: { providerId: api.providerId, label: api.name, kind: api.protocol === "anthropic" ? "anthropic" : "openai-compatible",
        apiFormat: api.protocol === "anthropic" ? "anthropic-messages" : api.protocol === "responses" ? "openai-responses" : "openai-chat-completions",
        source: "ephemeral", baseURL: api.baseUrl, apiKey: { source: "env", name: "HABOR_PROVIDER_KEY" }, models: [{ modelId, supportsTools: true,
          ...(this.opts?.reasoningLevels ? { reasoning: { enabled: true, levels: this.opts.reasoningLevels.map(value => ({ value, label: reasoningLabel(value) })) } } : {})
        }]
      }
    };
  }

  async getReasoningCapabilities(): Promise<ReasoningCapabilities> { await this.connect(); return this.reasoning; }
  private async applyReasoning(effort?: string): Promise<void> {
    assertReasoningLevel(this.reasoning, effort);
    await this.rpc!.request("session/setThoughtLevel", { sessionId: this.sessionId, thoughtLevel: effort ?? this.defaultThoughtLevel, persistAsWorkspaceLastUsed: false });
  }
  async setReasoningEffort(effort: string | undefined): Promise<void> {
    await this.connect(); await this.applyReasoning(effort); if (this.opts) this.opts.reasoningEffort = effort;
  }

  async *prompt(input: string): AsyncIterable<AgentEvent> {
    const base = { sessionId: this.id, adapterId: this.adapterId, model: this.model };
    const fail = (err: unknown) => ({
      type: "error" as const,
      error: { message: err instanceof Error ? err.message : String(err) },
      ...base,
      ts: Date.now()
    });

    let rpc: ZcodeRpc;
    try {
      await this.connect();
      if (this.opts?.reasoningEffort !== undefined) await this.applyReasoning(this.opts.reasoningEffort);
      rpc = this.rpc!;
    } catch (err) {
      yield fail(err);
      yield { type: "done" as const, ...base, ts: Date.now() };
      return;
    }
    const sessionId = this.sessionId!;

    const q: (Omit<AgentEvent, "ts" | "sessionId" | "adapterId" | "model"> | { __done: true })[] = [];
    let done = false;
    let streamedText = false; // 本 turn 是否已流式输出过文本（complete 去重）

    const prevOnNotification = rpc.onNotification;
    rpc.onNotification = (method, params) => {
      if (method === "session/event") {
        const p = params?.payload ?? {};
        const kind = p.kind;
        if (kind === "text_delta" && typeof p.delta === "string") {
          streamedText = true;
          q.push({ type: "message", delta: p.delta, text: p.delta });
        } else if (kind === "reasoning_delta" && typeof p.delta === "string") {
          q.push({ type: "thinking", thinking: p.delta });
        } else if (kind === "text_end" || kind === "reasoning_end") {
          /* 结束标记，忽略 */
        } else if (kind === "tool_call" || kind === "tool_call_started" || kind === "tool_started") {
          q.push({
            type: "tool_call",
            tool: { id: p.toolCallId ?? p.callId ?? "t", name: p.toolName ?? p.name ?? "tool", input: p.input ?? p.arguments ?? {} }
          });
        } else if (kind === "result") {
          // 工具执行结果（真正的完成事件，带 toolCallId + result）
          const res = p.result ?? {};
          const out = typeof res === "string" ? res
            : res.content !== undefined ? (typeof res.content === "string" ? res.content : JSON.stringify(res.content))
            : JSON.stringify(res).slice(0, 2000);
          q.push({
            type: "tool_result",
            toolResult: { id: p.toolCallId ?? p.callId ?? "t", name: p.toolName ?? p.name ?? "tool", output: out, isError: res.success === false || !!(res.error || p.error) }
          });
        } else if (kind === "tool_result" || kind === "tool_completed" || kind === "tool_call_result") {
          // 工具完成（另一种形态）
          const out = typeof p.result === "string" ? p.result
            : p.output !== undefined ? String(p.output)
            : p.content !== undefined ? (typeof p.content === "string" ? p.content : JSON.stringify(p.content))
            : JSON.stringify(p).slice(0, 2000);
          q.push({
            type: "tool_result",
            toolResult: { id: p.toolCallId ?? p.callId ?? "t", name: p.toolName ?? p.name ?? "tool", output: out, isError: !!(p.error || p.isError) }
          });
        } else if (kind === "tool_execution_failed" || kind === "tool_timeout" || kind === "tool_error") {
          q.push({
            type: "tool_result",
            toolResult: { id: p.toolCallId ?? p.callId ?? "t", name: p.toolName ?? p.name ?? "tool", output: toDisplayText(p.error ?? p.message ?? kind), isError: true }
          });
        } else if (kind === "complete" || (p.stopReason !== undefined && p.stopReason !== "tool-calls")) {
          // complete 事件没有 kind 字段：payload {content, stopReason, usage}
          const text = typeof p.content === "string" ? p.content : "";
          if (text && !streamedText) q.push({ type: "message", text });
          if (p.usage) {
            q.push({
              type: "usage",
              usage: {
                inputTokens: p.usage.inputTokens,
                outputTokens: p.usage.outputTokens,
                totalTokens: p.usage.totalTokens,
                cachedTokens: p.usage.cacheReadTokens,
                raw: p.usage
              }
            });
          }
          done = true;
        } else if (kind === "error" || p.error) {
          q.push({ type: "error", error: { message: toDisplayText(p.message ?? p.error ?? "zcode error") } });
          done = true;
        } else if (kind === "permission" || kind === "user_message" || kind === "state_updated") {
          /* 暂不处理 */
        }
      } else if (method === "state.updated") {
        /* 忽略 */
      }
      prevOnNotification?.(method, params);
    };

    try {
      await rpc.request("session/send", { sessionId, content: input });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!done) {
        while (q.length > 0) {
          const ev = q.shift()!;
          if ("__done" in ev) break;
          yield { ...ev, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model } as AgentEvent;
        }
        if (Date.now() > deadline) {
          yield fail(new Error("zcode turn timeout"));
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      while (q.length > 0) {
        const ev = q.shift()!;
        if ("__done" in ev) break;
        yield { ...ev, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model } as AgentEvent;
      }
    } catch (err) {
      yield fail(err);
    }
    yield { type: "done" as const, ...base, ts: Date.now() };
  }

  cancel(): Promise<void> {
    if (this.proc) this.proc.kill("SIGKILL");
    return Promise.resolve();
  }
  close(): Promise<void> {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      setTimeout(() => this.proc?.kill("SIGKILL"), 2000).unref();
    }
    return Promise.resolve();
  }
}

export class ZcodeStreamAdapter implements Adapter {
  readonly id = "zcode";
  readonly harnessName = "ZCode (GLM 官方 harness, 流式)";
  readonly models = ZCODE_MODELS;

  async isAvailable(): Promise<boolean> {
    return cliPath !== undefined;
  }

  async createSession(opts: SessionOptions): Promise<Session> {
    return new ZcodeSession(opts.model, opts.cwd, opts.permission ?? "auto", opts);
  }
}
