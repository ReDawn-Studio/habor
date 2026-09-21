import { accessSync, closeSync, constants, existsSync, openSync, readSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve, basename } from "node:path";
import { homedir } from "node:os";

export const AGENT_RUNTIMES: Record<string, { command: string; package?: string; compatibleVersion?: string; legacyPeerDeps?: boolean; override: string }> = {
  "codex-acp": { command: "codex", package: "@openai/codex", override: "HABOR_CODEX_BIN" },
  "claude-acp": { command: "claude", package: "@anthropic-ai/claude-code", override: "HABOR_CLAUDE_BIN" },
  "kimi-acp": { command: "kimi", package: "@moonshot-ai/kimi-code", override: "HABOR_KIMI_BIN" },
  "gemini-cli": { command: "gemini", package: "@google/gemini-cli", override: "HABOR_GEMINI_BIN" },
  "qwen-cli": { command: "qwen", package: "@qwen-code/qwen-code", override: "HABOR_QWEN_BIN" },
  "grok-cli": { command: "grok", override: "HABOR_GROK_BIN" },
  "dsh-acp": { command: "dsh", package: "@deepseek-ai/dsh", compatibleVersion: "0.1.0-rc.8", legacyPeerDeps: true, override: "HABOR_DSH_BIN" }
};
export function haborStateDir(): string { return process.env.HABOR_STATE_DIR ?? join(homedir(), ".habor"); }
export function agentInstallRoot(id: string, stateDir = haborStateDir()): string {
  if (!Object.hasOwn(AGENT_RUNTIMES, id)) throw new Error("未知安装目标");
  return join(stateDir, "agents", id);
}
export function executableOnPath(command: string): string | undefined {
  const suffixes = process.platform === "win32" && !extname(command)
    ? [...(process.env.PATHEXT ?? ".EXE;.COM;.CMD;.BAT").split(";").filter(Boolean), ""] : [""];
  const paths = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [resolve(command)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path.replace(/^"|"$/g, ""), command));
  const candidates = paths.flatMap(path => suffixes.map(suffix => path + suffix));
  return candidates.find(path => { try { accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}

/** Windows cannot execute Node shebangs or npm .cmd shims with shell:false.
 * Resolve their JS entry point and keep arguments out of cmd.exe (JSON and user
 * prompts must reach the client literally). Native .exe clients stay native.
 */
export function commandInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args };
  const file = executableOnPath(command) ?? command;
  const script = windowsNodeEntry(file);
  if (script) return { command: process.execPath, args: [script, ...args] };
  if (/\.(?:cmd|bat)$/i.test(file)) throw new Error(`无法解析 Windows 启动脚本：${file}；请将客户端路径设置为其 .exe 或 Node.js 入口文件`);
  return { command: file, args };
}

function windowsNodeEntry(file: string): string | undefined {
  if (/\.[cm]?js$/i.test(file)) return file;
  if (/\.(?:exe|com)$/i.test(file)) return;
  try {
    // Read only the header, even if an extensionless file is a large binary.
    const fd = openSync(file, "r"), buffer = Buffer.alloc(8192);
    let text: string;
    try { text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"); }
    finally { closeSync(fd); }
    if (/^#![^\r\n]*\bnode(?:\s|$)/.test(text)) return file;
    if (!/\.(?:cmd|bat)$/i.test(file)) return;
    // Node's bundled npm/npx shims use intermediate environment variables.
    const name = basename(file, extname(file)).toLowerCase();
    if (name === "npm" || name === "npx") {
      const entry = join(dirname(file), "node_modules", "npm", "bin", `${name}-cli.js`);
      if (existsSync(entry)) return entry;
    }
    // npm/pnpm command shims point to a script relative to their own directory.
    const match = text.match(/"%(?:dp0%|~dp0)[\\/]([^"\r\n]*\.[cm]?js)"\s+%\*/i);
    if (match) {
      const entry = resolve(dirname(file), match[1]);
      if (statSync(entry).isFile()) return entry;
    }
  } catch { /* Leave missing/unknown executables to the normal spawn error. */ }
}
export function managedAgentExecutable(id: string, stateDir = haborStateDir()): string | undefined {
  const spec = AGENT_RUNTIMES[id];
  if (!spec) return;
  try {
    const root = agentInstallRoot(id, stateDir);
    const active = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
    if (active.package !== spec.package || typeof active.install !== "string" || !/^[a-f0-9-]{36}$/.test(active.install)) return;
    return executableOnPath(join(root, "versions", active.install, "node_modules", ".bin", spec.command));
  } catch { return; }
}
/** Explicit user override wins; a managed install is used only after a verified activation. */
export function agentExecutable(id: string): string {
  const spec = AGENT_RUNTIMES[id];
  if (!spec) throw new Error("未知客户端");
  return process.env[spec.override] || managedAgentExecutable(id) || executableOnPath(spec.command) || spec.command;
}
export function dshPackageAnchor(): string | undefined {
  const binary = executableOnPath(agentExecutable("dsh-acp"));
  if (!binary) return;
  try {
    let dir = dirname(realpathSync(process.platform === "win32" ? windowsNodeEntry(binary) ?? binary : binary));
    for (let depth = 0; depth < 5; depth++, dir = dirname(dir)) {
      const file = join(dir, "package.json");
      if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === AGENT_RUNTIMES["dsh-acp"].package) return file;
    }
  } catch { return; }
}
