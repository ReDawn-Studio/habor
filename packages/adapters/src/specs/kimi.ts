/**
 * adapters/specs/kimi.ts — Kimi Code CLI（Kimi 官方 harness）（声明式 spec）。
 *
 * 实测：`kimi -p <prompt> --output-format stream-json`（本机 ~/.kimi-code/bin/kimi）。
 *   - 事件形如 {"role":"meta","type":"system.version",...}；-p 与 --yolo 不能共存。
 *   - 本机当前 Kimi 周配额已用尽（403），解析器按防御式写入，配额恢复即可用。
 */
import type { CliAgentSpec } from "../framework.js";

const KIMI_MODELS = ["Kimi K3"];

export const kimiSpec: CliAgentSpec = {
  id: "kimi",
  harnessName: "Kimi Code CLI (Kimi 官方 harness)",
  models: KIMI_MODELS,
  timeoutMs: 20 * 60 * 1000,
  buildCommand: ({ prompt }) => ({
    cmd: "kimi",
    argv: ["-p", prompt, "--output-format", "stream-json"]
  }),
  parseLine: (line, emit) => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const text =
      ev?.content ??
      ev?.text ??
      (Array.isArray(ev?.message?.content)
        ? ev.message.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
        : undefined);
    if (typeof text === "string" && text.length > 0) emit({ type: "message", text });
    if (ev?.type === "error" || ev?.error) {
      emit({
        type: "error",
        error: { message: ev.error?.message ?? JSON.stringify(ev.error), code: ev.error?.code }
      });
    }
    if (ev?.usage || ev?.usage_total) {
      const u = ev.usage ?? ev.usage_total;
      emit({
        type: "usage",
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          totalTokens: u.total_tokens,
          raw: u
        }
      });
    }
  },
  onExit: ({ exitCode, stderr, emitted }, emit) => {
    if (!emitted && exitCode !== 0) {
      emit({ type: "error", error: { message: stderr.trim() || "kimi 运行失败", code: String(exitCode) } });
    }
  }
};
