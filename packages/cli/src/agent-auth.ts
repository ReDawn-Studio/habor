import { agentExecutable, executableOnPath } from "@agent-router/core";
import { runAgentCommand, type AgentCommand } from "./agent-process.js";

export type AuthMethod = "browser" | "device" | "native";
export interface AuthAction { id: AuthMethod; label: string; description: string }
export type AuthStatus = { state: "authenticated" | "signed-out" | "unknown"; text: string };
export const AUTH_ACTIONS: Record<string, AuthAction[]> = {
  "codex-acp": [
    { id: "browser", label: "使用 ChatGPT 账号登录", description: "打开 Codex 原生浏览器授权；账号需具备相应使用资格。" },
    { id: "device", label: "使用设备码登录", description: "在浏览器输入原生客户端给出的设备码，适用于 SSH 等环境。" }
  ],
  "claude-acp": [{ id: "browser", label: "使用 Claude 账号登录", description: "通过 Claude Code 原生授权；订阅与 API 额度分别结算。" }],
  "kimi-acp": [{ id: "device", label: "使用 Kimi 账号 / 设备码登录", description: "通过 Kimi Code 原生设备码授权，保留原生凭据自动刷新。" }],
  "gemini-cli": [{ id: "native", label: "打开 Gemini 原生认证 /auth", description: "在原生界面输入 /auth，选择 Google 登录、API Key 或 Vertex AI。" }],
  "qwen-cli": [{ id: "native", label: "打开 Qwen 原生认证 /auth", description: "在原生界面输入 /auth；旧 Qwen OAuth 已停用，使用当前提供商选项。" }],
  "dsh-acp": [{ id: "native", label: "打开 DSH 原生配置", description: "启动 DSH Web，在 Models 页面配置；完成后 Ctrl+C 返回 habor。" }],
  zcode: [{ id: "native", label: "打开 ZCode 登录 / 配置", description: "在 ZCode 完成账号、Coding Plan 或 API Key 配置，然后返回这里。" }]
};

export function nativeLoginCommand(id: string, method: AuthMethod, cwd: string): AgentCommand {
  if (!AUTH_ACTIONS[id]?.some(action => action.id === method)) throw new Error("此客户端不支持该认证方式");
  if (id === "zcode") {
    if (process.platform !== "darwin") throw new Error("请手动打开 ZCode 完成登录，再返回 habor");
    return { command: "open", args: ["-a", "ZCode"], cwd };
  }
  const args = id === "codex-acp" ? ["login", ...(method === "device" ? ["--device-auth"] : [])]
    : id === "claude-acp" ? ["auth", "login"] : id === "kimi-acp" ? ["login"] : ["gemini-cli", "qwen-cli"].includes(id) ? [] : ["web"];
  return { command: agentExecutable(id), args, cwd };
}

/** Only explicit native status commands establish login state. Configuration-file presence is not authentication. */
export async function nativeAuthStatus(id: string, cwd: string): Promise<AuthStatus> {
  if (!["codex-acp", "claude-acp"].includes(id)) return { state: "unknown", text: "原生客户端未提供统一认证状态；连接时验证" };
  if (!executableOnPath(agentExecutable(id))) return { state: "unknown", text: "尚未安装客户端" };
  try {
    const result = await runAgentCommand({ command: agentExecutable(id), args: id === "codex-acp" ? ["login", "status"] : ["auth", "status", "--json"], cwd }, { timeoutMs: 10000 });
    if (id === "claude-acp") {
      const status = JSON.parse(result.output);
      const method = /api/i.test(status.authMethod ?? "") ? "（API Key）" : /oauth|claude/i.test(status.authMethod ?? "") ? "（账号授权）" : "";
      if (typeof status.loggedIn === "boolean") return status.loggedIn ? { state: "authenticated", text: `原生客户端报告：已认证${method}` } : { state: "signed-out", text: "原生客户端报告：尚未登录" };
    } else {
      if (/not logged in/i.test(result.output)) return { state: "signed-out", text: "原生客户端报告：尚未登录" };
      if (result.code === 0 && /logged in/i.test(result.output)) return { state: "authenticated", text: `原生客户端报告：已认证${/chatgpt/i.test(result.output) ? "（ChatGPT）" : /api key/i.test(result.output) ? "（API Key）" : ""}` };
    }
  } catch { /* Unsupported CLI version or unavailable status: do not guess. */ }
  return { state: "unknown", text: "无法确认认证状态；可重新登录或使用 API Key" };
}
