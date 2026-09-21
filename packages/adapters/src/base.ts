/**
 * adapters/base.ts — 子进程 CLI 的公共工具。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { commandInvocation, executableOnPath } from "@agent-router/core";

export interface SpawnOptions {
  cmd: string;
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 收集 stdout/stderr 并等待进程结束。 */
export function runCli(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const launch = commandInvocation(opts.cmd, opts.argv);
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}

/**
 * 逐行流式运行 CLI。返回进程句柄 + 行异步迭代器。
 * cancel 通过 kill() 实现。
 */
export function runCliLines(opts: SpawnOptions): {
  child: ChildProcess;
  lines: AsyncIterable<string>;
  result: Promise<SpawnResult>;
} {
  const launch = commandInvocation(opts.cmd, opts.argv);
  const child = spawn(launch.command, launch.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));

  async function* lines(): AsyncIterable<string> {
    let buf = "";
    for await (const chunk of child.stdout) {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, idx);
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.length > 0) yield buf;
  }

  const result = new Promise<SpawnResult>((resolve) => {
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout: "", stderr, timedOut: false });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", stderr: `${stderr}\n${err.message}`, timedOut: false });
    });
  });

  return { child, lines: lines(), result };
}

/** 查找本机是否安装了某个命令。 */
export async function hasCommand(cmd: string): Promise<boolean> {
  return executableOnPath(cmd) !== undefined;
}

export function resolveNode(): string {
  return process.execPath;
}

export function env(name: string): string | undefined {
  return process.env[name];
}

// re-export for convenience
export { createRequire };
