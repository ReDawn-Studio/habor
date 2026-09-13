import { toDisplayText } from "./text.js";
import { redactSecrets } from "./connections.js";

/** JSON-RPC's generic message is an envelope; providers put the cause in data/details. */
export function describeAgentError(error: unknown, secrets: string[] = []): { message: string; code?: string } {
  const messages: string[] = [];
  const seen = new WeakSet<object>();
  let code: string | undefined;
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      if (/^[\[{\"]/.test(text)) {
        try {
          const before = messages.length;
          collect(JSON.parse(text), depth + 1);
          if (messages.length > before) return;
        } catch { /* Plain provider text may begin with a JSON delimiter. */ }
      }
      messages.push(text);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string") code = record.code;
    // More specific nested errors precede the JSON-RPC wrapper message.
    for (const field of ["data", "details", "error", "cause", "message"]) collect(record[field], depth + 1);
  };
  collect(error);
  const generic = /^(?:internal error|unknown error|request failed)[.!]?$/i;
  const detail = messages.find(message => !generic.test(message)) ?? messages[0] ?? toDisplayText(error);
  const safe = redactSecrets(detail, secrets);
  const providerCode = safe.match(/"code"\s*:\s*"([\w.-]+)"/)?.[1] ?? code;
  if (/requires? a newer version of Codex/i.test(safe)) {
    const model = safe.match(/['"]([^'"]+)['"]\s+model/i)?.[1];
    return { code: "CODEX_UPGRADE_REQUIRED", message: `${model ?? "当前模型"} 需要更新版本的 Codex CLI。\n请运行 codex update 升级，然后退出并重新启动 habor。` };
  }
  if (providerCode === "InvalidSubscription" || /\bInvalidSubscription\b/.test(safe)) {
    return { code: "InvalidSubscription", message: "当前 API 来源的订阅无效或已过期（InvalidSubscription）。\n请检查上方实际连接的提供商；在该服务处理订阅状态，或按 F3 /providers 配置一条有效连接。" };
  }
  return { message: safe || "原生客户端发生错误，未返回详细原因", ...(providerCode ? { code: providerCode } : {}) };
}
