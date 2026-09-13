import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_RUNTIMES, agentInstallRoot, executableOnPath, haborStateDir } from "@agent-router/core";
import { runAgentCommand, type AgentCommand, type RunOptions } from "./agent-process.js";
import { DSH_COMPATIBLE_PEERS } from "./dsh-compatibility.js";

export function installPlan(id: string, stateDir = haborStateDir()): { package: string; version: string; flags: string[]; root: string; description: string } {
  const spec = AGENT_RUNTIMES[id];
  if (!spec?.package) throw new Error("此客户端需使用官方桌面安装程序");
  const root = agentInstallRoot(id, stateDir);
  const version = spec.compatibleVersion ?? "latest";
  const flags = spec.legacyPeerDeps ? ["--legacy-peer-deps", "--prefer-offline"] : [];
  return { package: spec.package, version, flags, root, description: `npm install ${spec.package}@${version}${flags.length ? ` ${flags.join(" ")}` : ""} → ${root}` };
}

export class AgentInstaller {
  private running = new Set<string>();
  constructor(private stateDir = haborStateDir(), private runner: (command: AgentCommand, options?: RunOptions) => Promise<{ code: number; output: string }> = runAgentCommand) {}
  async install(id: string, options: RunOptions = {}): Promise<string> {
    const plan = installPlan(id, this.stateDir), spec = AGENT_RUNTIMES[id];
    if (process.platform === "win32") throw new Error("自动安装目前支持 macOS / Linux；Windows 请用 WSL 或官方安装页");
    if (this.running.has(id)) throw new Error("此 Agent 正在安装");
    const npm = executableOnPath("npm");
    if (!npm) throw new Error("未找到 npm，请先安装带 npm 的 Node.js，再重试");
    const root = plan.root, install = randomUUID(), stage = join(root, "versions", install);
    const cache = join(this.stateDir, "npm-cache");
    const lock = join(root, "install.lock");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error(`另一个进程正在安装；若上次异常退出，请确认无安装进程后移除 ${lock}`); }
    this.running.add(id);
    let activated = false;
    try {
      mkdirSync(stage, { recursive: true, mode: 0o700 });
      if (id === "dsh-acp") writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "habor-dsh-runtime", private: true, version: "0.0.0", dependencies: { ...DSH_COMPATIBLE_PEERS, [plan.package]: plan.version } }), { mode: 0o600 });
      const result = await this.runner({ command: process.execPath, args: [realpathSync(npm), "install", "--prefix", stage, "--cache", cache, "--no-audit", "--no-fund", "--package-lock=true", "--registry=https://registry.npmjs.org", ...plan.flags, `${plan.package}@${plan.version}`], cwd: stage }, { ...options, timeoutMs: options.timeoutMs ?? 600000 });
      if (result.code !== 0) throw new Error(`安装失败（退出码 ${result.code}），已保留原有客户端。${result.output.slice(-1500)}`);
      const manifest = JSON.parse(readFileSync(join(stage, "node_modules", ...plan.package.split("/"), "package.json"), "utf8"));
      if (manifest.name !== plan.package || typeof manifest.version !== "string") throw new Error("安装包标识校验失败");
      if (plan.version !== "latest" && manifest.version !== plan.version) throw new Error("安装版本不符合此 Agent 的桥接兼容要求");
      const binary = executableOnPath(join(stage, "node_modules", ".bin", spec.command));
      if (!binary) throw new Error("安装完成但未找到可执行文件");
      const check = await this.runner({ command: binary, args: ["--version"], cwd: stage }, { signal: options.signal, timeoutMs: 15000 });
      if (check.code !== 0) throw new Error(`客户端版本检查失败，原有客户端保持可用。${check.output.slice(-1200)}`);
      if (options.signal?.aborted) throw new Error("操作已取消");
      const temporary = join(root, `.active-${install}.json`);
      writeFileSync(temporary, JSON.stringify({ install, package: plan.package, version: manifest.version, installedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, join(root, "active.json"));
      activated = true;
      return manifest.version;
    } finally {
      if (!activated) rmSync(stage, { recursive: true, force: true });
      rmSync(lock, { recursive: true, force: true });
      this.running.delete(id);
    }
  }
}
