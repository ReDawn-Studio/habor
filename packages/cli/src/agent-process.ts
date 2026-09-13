import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface AgentCommand { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export interface RunOptions { signal?: AbortSignal; timeoutMs?: number; onOutput?: (line: string) => void; inherit?: boolean }

export function safeProcessText(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b(?:npm_|ghp_|github_pat_)[A-Za-z0-9_]{10,}/g, "[REDACTED]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)(?:Bearer\s+)?[^\s,]+/gi, "$1[REDACTED]");
}

/** Login uses inherited terminal I/O; it is never collected into the conversation transcript. */
export async function runAgentCommand(spec: AgentCommand, options: RunOptions = {}): Promise<{ code: number; output: string }> {
  if (options.signal?.aborted) throw new Error("操作已取消");
  return new Promise((resolve, reject) => {
    const grouped = !options.inherit && process.platform !== "win32";
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env ?? process.env, shell: false, detached: grouped, stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let output = "", stopped = "", killTimer: NodeJS.Timeout | undefined;
    const stop = (reason: string) => {
      stopped ||= reason;
      const kill = (signal: NodeJS.Signals) => { try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ } };
      kill("SIGTERM"); killTimer ??= setTimeout(() => kill("SIGKILL"), 1500);
    };
    const cancel = () => stop("操作已取消");
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timeout = setTimeout(() => stop("操作超时，请检查网络后重试"), options.timeoutMs ?? 120000);
    const cleanups: Array<() => void> = [];
    for (const stream of [child.stdout, child.stderr]) if (stream) {
      const decoder = new StringDecoder("utf8"); let pending = "";
      const line = (text: string) => { const safe = safeProcessText(text); output = (output + safe + "\n").slice(-32000); options.onOutput?.(safe); };
      stream.on("data", data => {
        pending += decoder.write(data);
        let split: number;
        while ((split = pending.search(/[\r\n]/)) >= 0) { line(pending.slice(0, split)); pending = pending.slice(split + 1); }
        if (pending.length > 16000) { pending = pending.slice(-1000); line("输出过长，已省略部分安装日志"); }
      });
      cleanups.push(() => { pending += decoder.end(); if (pending) line(pending); });
    }
    const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); options.signal?.removeEventListener("abort", cancel); };
    child.once("error", error => { cleanup(); reject(new Error(safeProcessText(error.message))); });
    child.once("close", (code, signal) => { cleanup(); cleanups.forEach(fn => fn()); if (stopped) reject(new Error(stopped)); else resolve({ code: code ?? (signal === "SIGINT" ? 130 : 1), output }); });
  });
}
