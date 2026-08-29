/**
 * adapters/specs/codex.ts — Codex CLI（OpenAI 官方 harness）（声明式 spec）。
 *
 * 实测：`codex exec --json <prompt>` 输出 JSONL：
 *   {"type":"thread.started"} /
 *   {"type":"item.completed","item":{type: agent_message|reasoning|tool_use|error,...}} /
 *   {"type":"turn.completed","usage":{...}}
 * 非 git 目录需 --skip-git-repo-check（始终加上；在 git 仓库内无副作用）。
 */
import type { CliAgentSpec } from "../framework.js";

const CODEX_MODELS = ["GPT-5.5"];

export const codexSpec: CliAgentSpec = {
  id: "codex",
  harnessName: "Codex CLI (OpenAI 官方 harness)",
  models: CODEX_MODELS,
  timeoutMs: 30 * 60 * 1000,
  buildCommand: ({ prompt, permission }) => {
    const argv = ["exec", "--json", "--skip-git-repo-check"];
    if (permission === "auto") argv.push("--dangerously-bypass-approvals-and-sandbox");
    argv.push(prompt);
    return { cmd: "codex", argv };
  },
  parseLine: (line, emit) => {
    if (!line.startsWith("{")) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "item.completed" && ev.item) {
      const it = ev.item;
      if (it.type === "agent_message" && typeof it.text === "string") {
        emit({ type: "message", text: it.text });
      } else if (it.type === "reasoning") {
        const r = typeof it.text === "string" ? it.text : it.summary ?? "";
        if (r) emit({ type: "thinking", thinking: r });
      } else if (it.type === "tool_use" || it.type === "function_call") {
        emit({
          type: "tool_call",
          tool: {
            id: it.id ?? it.tool_call_id ?? "t",
            name: it.name ?? it.tool_name ?? "tool",
            input: it.input ?? it.arguments ?? it
          }
        });
      } else if (it.type === "error" || (it.type === "message" && it.message?.role === "error")) {
        emit({ type: "error", error: { message: it.message ?? it.text ?? "codex 错误" } });
      }
    } else if (ev.type === "turn.completed" && ev.usage) {
      emit({
        type: "usage",
        usage: {
          inputTokens: ev.usage.input_tokens,
          outputTokens: ev.usage.output_tokens,
          cachedTokens: ev.usage.cached_input_tokens,
          totalTokens: ev.usage.input_tokens + ev.usage.output_tokens,
          raw: ev.usage
        }
      });
    }
  },
  onExit: ({ exitCode, stderr, emitted }, emit) => {
    if (exitCode !== 0 && stderr.trim()) {
      // codex 的 model-cache 等噪音过滤
      const clean = stderr
        .split("\n")
        .filter((l) => l.trim() && !/ERROR codex_models_manager/.test(l))
        .join("\n")
        .trim();
      if (clean && !emitted) {
        emit({ type: "error", error: { message: clean, code: String(exitCode) } });
      }
    }
  }
};
