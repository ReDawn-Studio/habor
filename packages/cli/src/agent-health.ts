import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import { AGENT_RUNTIMES, agentExecutable } from "@agent-router/core";
import { ALL_ACP_SPECS, probeAgentProtocol } from "@agent-router/adapters";
import { safeProcessText, type AgentCommand } from "./agent-process.js";

/** Probe only transports whose initialize handshake is independent of login.
 * Other clients retain an explicit version-only installation check.
 */
export function agentHealthPlan(id: string, binary: string, workspace: string): AgentCommand | undefined {
  if (!["dsh-acp", "codex-acp", "kimi-acp"].includes(id)) return;
  return {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), "--probe-agent", id],
    cwd: workspace,
    env: {
      ...process.env,
      [AGENT_RUNTIMES[id].override]: binary,
      HABOR_STATE_DIR: join(workspace, "habor"),
      DSH_HOME: join(workspace, "dsh"),
      CODEX_HOME: join(workspace, "codex"),
      // Installation health must not depend on an inherited API connection.
      HABOR_DSH_BASE_URL: "", HABOR_DSH_API_KEY: ""
    }
  };
}

async function main(id: string): Promise<void> {
  if (id === "codex-acp") {
    if (process.env.CODEX_HOME) mkdirSync(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
    await probeAgentProtocol({ command: agentExecutable(id), args: ["app-server"], cwd: process.cwd(), protocol: "codex" });
  } else if (id === "dsh-acp" || id === "kimi-acp") {
    const spec = ALL_ACP_SPECS.find(entry => entry.id === id)!;
    const launch = id === "kimi-acp" ? { cmd: agentExecutable(id), argv: ["acp"], env: undefined }
      : spec.command({ model: "DeepSeek", modelId: "deepseek-flash" });
    await probeAgentProtocol({ command: launch.cmd, args: launch.argv, env: launch.env, cwd: process.cwd(), protocol: "acp" });
  } else throw new Error("此客户端没有离线协议检查");
  console.log("本地启动与协议握手检查通过；账号和模型权限将在连接时验证");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[3] ?? "").catch(error => { console.error(safeProcessText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
}
