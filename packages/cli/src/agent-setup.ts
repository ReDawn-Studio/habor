import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Public official setup pages. Provider input must never become an executable or an install URL. */
export const AGENT_SETUP: Record<string, { name: string; url: string; detection: string }> = {
  "codex-acp": { name: "Codex CLI", url: "https://learn.chatgpt.com/docs/codex/cli", detection: "需能在当前终端运行 codex；自定义路径用 HABOR_CODEX_BIN。" },
  "claude-acp": { name: "Claude Code", url: "https://code.claude.com/docs/en/setup", detection: "需能在当前终端运行 claude；自定义路径用 HABOR_CLAUDE_BIN。" },
  "kimi-acp": { name: "Kimi Code CLI", url: "https://moonshotai.github.io/kimi-code/en/guides/getting-started", detection: "需能在当前终端运行 kimi，并支持 kimi acp。" },
  "dsh-acp": { name: "DeepSeek Harness", url: "https://github.com/deepseek-ai/deepseek-harness", detection: "需安装 @deepseek-ai/dsh 并使 dsh 命令位于 PATH。" },
  "gemini-cli": { name: "Gemini CLI", url: "https://geminicli.com/docs/get-started/authentication/", detection: "官方 CLI 支持 --acp；认证仍由 Gemini 原生登录、API Key 或 Vertex AI 管理。" },
  "qwen-cli": { name: "Qwen Code", url: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/", detection: "官方 CLI 支持 --acp；使用原生 /auth 配置 ModelStudio、Coding Plan 或自定义 Key。" },
  "grok-cli": { name: "Grok Build", url: "https://docs.x.ai/build/overview", detection: "官方 `grok agent stdio` ACP 入口；首次启动浏览器登录，或使用 XAI_API_KEY。" },
  zcode: { name: "ZCode", url: "https://zcode.z.ai/cn/docs/install", detection: "macOS 检测 Applications 中的 ZCode；其他路径用 ZCODE_CLI 指向 zcode.cjs。" }
};

/** Legacy export kept for third-party UI integrations; production routing uses MODEL_CATALOG ACP entries. */
export const EXTERNAL_AGENT_TARGETS = [] as const;

export async function openAgentInstallPage(adapterId: string): Promise<void> {
  const guide = AGENT_SETUP[adapterId];
  if (!guide) throw new Error("此 Agent 暂无安装说明");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", guide.url] : [guide.url];
  try { await promisify(execFile)(command, args, { timeout: 10000 }); }
  catch { throw new Error(`无法打开浏览器，请手动访问 ${guide.url}`); }
}

export function missingAgentMessage(adapterId: string): string {
  const guide = AGENT_SETUP[adapterId];
  return guide ? `未检测到 ${guide.name}。安装说明：${guide.url}。安装后重新检测；若修改了 PATH，请重启 habor。` : `未检测到 Agent：${adapterId}`;
}
