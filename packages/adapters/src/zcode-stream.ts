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
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(m.error.message ?? "zcode rpc error")) : resolve(m.result)));
      this.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`zcode rpc timeout: ${method}`));
        }
      }, 60000);
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

  constructor(
    readonly model: string,
    readonly cwd: string,
    readonly permission: "ask" | "auto"
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
      const proc = spawn(process.execPath, [cliPath, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
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
        }
      };

      proc.on("exit", () => {
        this.proc = null;
        this.connected = null;
      });

      void (async () => {
        try {
          const workspaceKey = `habor-${this.id}`;
          const result = await rpc.request("session/create", {
            workspace: { workspacePath: this.cwd, workspaceKey }
          });
          // sessionId 由 requestRuntimePreferences 回调给出
          // 等 sessionId 就绪（create 过程中服务端会先发 requestRuntimePreferences）
          const deadline = Date.now() + 20000;
          while (!this.sessionId && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!this.sessionId) throw new Error("zcode: 未拿到 sessionId");
          await rpc.request("session/subscribe", {
            sessionId: this.sessionId,
            deliveryKind: "web-remote-replayable"
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      })();
    });
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
        } else if (kind === "tool_call") {
          q.push({
            type: "tool_call",
            tool: { id: p.toolCallId ?? p.callId ?? "t", name: p.toolName ?? p.name ?? "tool", input: p.input ?? p.arguments ?? {} }
          });
        } else if (kind === "complete" || p.stopReason !== undefined) {
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
          q.push({ type: "error", error: { message: p.message ?? p.error ?? "zcode error" } });
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
    return new ZcodeSession(opts.model, opts.cwd, opts.permission ?? "auto");
  }
}
