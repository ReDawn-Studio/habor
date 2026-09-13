import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { toDisplayText, redactSecrets } from "@agent-router/core";

/** Line-delimited JSON-RPC over an owned native process; failed requests always settle. */
export class NativeRpc {
  readonly child: ChildProcessWithoutNullStreams;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async () => { throw new Error("不支持的客户端请求"); };
  onClose: (error: Error) => void = () => {};
  private seq = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private stderr = "";
  private closed = false;
  constructor(cmd: string, argv: string[], cwd: string, env = process.env, private secrets: string[] = []) {
    this.child = spawn(cmd, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", data => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    createInterface({ input: this.child.stdout }).on("line", line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        void this.onRequest(message.method, message.params).then(result => this.write({ id: message.id, result }), error => this.write({ id: message.id, error: { code: -32603, message: this.safe(error) } }));
      } else if (message.method) this.onNotification(message.method, message.params);
      else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(this.safe(message.error)));
        else pending.resolve(message.result);
      }
    });
    this.child.on("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.child.on("exit", code => this.fail(new Error(`${cmd} 已退出 (${code ?? "signal"})${this.stderr ? `：${this.stderr.trim()}` : ""}`)));
  }
  private safe(error: unknown): string {
    let message = toDisplayText(error);
    if (error && typeof error === "object" && "data" in error && error.data) message += `：${toDisplayText(error.data)}`;
    return redactSecrets(message, this.secrets);
  }
  private write(message: unknown): void {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("原生客户端连接已关闭，请重试"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时，请检查客户端与网络`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown = {}): void { this.write({ method, params }); }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const safe = new Error(this.safe(error));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(safe); }
    this.pending.clear(); this.onClose(safe);
  }
  close(): void { this.fail(new Error("会话已关闭")); this.child.kill("SIGTERM"); const child = this.child; setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000).unref(); }
}

export class EventQueue<T> {
  private items: T[] = [];
  private stopped = false;
  private wake?: () => void;
  push(item: T): void { if (!this.stopped) this.items.push(item); this.wake?.(); }
  finish(): void { this.stopped = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    for (;;) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.stopped) return;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
