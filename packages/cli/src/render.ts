/**
 * cli/src/render.ts — 把统一 AgentEvent 渲染到终端。
 */
import type { AgentEvent } from "@agent-router/core";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`
};

/** 渲染一个事件（逐事件一行或多行）。返回要打印的文本。 */
export function renderEvent(ev: AgentEvent): string {
  switch (ev.type) {
    case "message":
      return ev.text ?? "";
    case "thinking":
      return ev.thinking ? C.dim(ev.thinking) : "";
    case "tool_call":
      return (
        C.cyan(`  ⚙ ${ev.tool?.name} `) +
        C.gray(
          typeof ev.tool?.input === "string"
            ? ev.tool.input.slice(0, 200)
            : JSON.stringify(ev.tool?.input ?? {}).slice(0, 200)
        )
      );
    case "tool_result": {
      const out = ev.toolResult?.output ?? "";
      // 折叠：最多 3 行、400 字符
      const lines = out.split("\n").slice(0, 3);
      const head = lines.join("\n").slice(0, 400);
      const truncated = out.length > 400 || lines.length < out.split("\n").length;
      return C.gray(`  └ ${head}${truncated ? "…" : ""}`);
    }
    case "file_change":
      return C.gray(
        `  ✎ ${ev.file?.type} ${ev.file?.path}${ev.file?.added != null || ev.file?.removed != null ? ` (+${ev.file?.added ?? 0}/-${ev.file?.removed ?? 0})` : ""}`
      );
    case "terminal":
      return ev.terminal?.output ? C.gray(ev.terminal.output) : "";
    case "permission":
      return C.yellow(`  ? 需要确认: ${ev.permission?.description}`);
    case "usage": {
      const u = ev.usage;
      if (!u) return "";
      const parts = [
        u.inputTokens != null ? `in ${u.inputTokens}` : "",
        u.outputTokens != null ? `out ${u.outputTokens}` : "",
        u.cachedTokens != null ? `cached ${u.cachedTokens}` : ""
      ].filter(Boolean);
      // ACP usage_update 形态：仅 used/size
      const raw = u.raw as { used?: number; size?: number } | undefined;
      const usedPart = raw?.used != null ? `${raw.used}/${raw.size}` : "";
      return C.gray(`  (usage: ${parts.join(" / ")}${parts.length > 0 && usedPart ? " · " : ""}${usedPart})`);
    }
    case "error":
      return C.red(`  ✗ ${ev.error?.message ?? "错误"}`);
    case "done":
      return "";
  }
}
