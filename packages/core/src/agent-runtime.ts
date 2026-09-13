import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export const AGENT_RUNTIMES: Record<string, { command: string; package?: string; compatibleVersion?: string; legacyPeerDeps?: boolean; override: string }> = {
  "codex-acp": { command: "codex", package: "@openai/codex", override: "HABOR_CODEX_BIN" },
  "claude-acp": { command: "claude", package: "@anthropic-ai/claude-code", override: "HABOR_CLAUDE_BIN" },
  "kimi-acp": { command: "kimi", package: "@moonshot-ai/kimi-code", override: "HABOR_KIMI_BIN" },
  "gemini-cli": { command: "gemini", package: "@google/gemini-cli", override: "HABOR_GEMINI_BIN" },
  "qwen-cli": { command: "qwen", package: "@qwen-code/qwen-code", override: "HABOR_QWEN_BIN" },
  "dsh-acp": { command: "dsh", package: "@deepseek-ai/dsh", compatibleVersion: "0.1.0-rc.8", legacyPeerDeps: true, override: "HABOR_DSH_BIN" }
};
export function haborStateDir(): string { return process.env.HABOR_STATE_DIR ?? join(homedir(), ".habor"); }
export function agentInstallRoot(id: string, stateDir = haborStateDir()): string {
  if (!Object.hasOwn(AGENT_RUNTIMES, id)) throw new Error("未知安装目标");
  return join(stateDir, "agents", id);
}
export function executableOnPath(command: string): string | undefined {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\") ? [command] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(path => {
    const suffixes = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
    return suffixes.map(suffix => join(path, command + suffix));
  });
  return candidates.find(path => { try { accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
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
    let dir = dirname(realpathSync(binary));
    for (let depth = 0; depth < 5; depth++, dir = dirname(dir)) {
      const file = join(dir, "package.json");
      if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === AGENT_RUNTIMES["dsh-acp"].package) return file;
    }
  } catch { return; }
}
