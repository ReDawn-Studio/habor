import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { commandInvocation, describeAgentError, closeProcess } from "@agent-router/core";
import { ProcessDiagnostics } from "./process-diagnostics.js";

export type AgentProtocol = "acp" | "codex";

/** Offline installation check: boot the real server and negotiate its protocol.
 * No session, prompt, login or model inference is requested.
 */
export async function probeAgentProtocol(options: {
  command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv;
  protocol: AgentProtocol; timeoutMs?: number;
}): Promise<void> {
  const env = { ...process.env, ...options.env };
  const invocation = commandInvocation(options.command, options.args);
  const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const secrets = Object.entries(env).filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name)).map(([, value]) => value ?? "");
  const diagnostics = new ProcessDiagnostics(secrets);
  child.stderr.on("data", chunk => diagnostics.push(chunk));
  child.stderr.once("end", () => diagnostics.finish());
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let timer: NodeJS.Timeout | undefined;
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("原生客户端协议握手超时")), options.timeoutMs ?? 20000);
      child.once("error", reject);
      child.stdin.on("error", reject);
      child.once("close", code => reject(new Error(`原生客户端在协议就绪前退出（退出码 ${code ?? "signal"}）`)));
      createInterface({ input: child.stdout }).on("line", line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 1) return;
        if (message.error) { reject(message.error); return; }
        const result = message.result;
        const valid = options.protocol === "acp"
          ? result?.protocolVersion === PROTOCOL_VERSION && result.agentCapabilities && typeof result.agentCapabilities === "object"
          : typeof result?.userAgent === "string";
        if (!valid) reject(new Error("原生客户端返回了不兼容的 initialize 响应"));
        else resolve();
      });
      const params = options.protocol === "acp"
        ? { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }
        : { clientInfo: { name: "habor_install_check", version: "1" }, capabilities: { experimentalApi: true } };
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params }) + "\n");
    });
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    // Let DSH dispose its per-process profile; force-stop unresponsive clients.
    await closeProcess(child);
    await closed;
  }
  if (failure) {
    const detail = describeAgentError(failure, secrets).message;
    throw new Error(`${detail}${diagnostics.text() ? `\n${diagnostics.text()}` : ""}`);
  }
}
