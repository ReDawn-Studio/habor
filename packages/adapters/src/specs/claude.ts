/**
 * adapters/specs/claude.ts — Claude Code CLI（Anthropic 官方 harness）（声明式 spec）。
 *
 * 实测：`claude -p <prompt> --output-format stream-json --verbose [--include-partial-messages]`
 * 事件：{"type":"system","subtype":"init"} /
 *       {"type":"assistant","message":{content:[thinking|text|tool_use], usage}} /
 *       {"type":"user","message":{content:[tool_result]}} /
 *       {"type":"result","subtype":"success"|"error_*"} /
 *       {"type":"stream_event","event":{content_block_delta}}
 */
import type { CliAgentSpec } from "../framework.js";

const CLAUDE_MODELS = ["Claude Sonnet 4.6"];

export const claudeSpec: CliAgentSpec = {
  id: "claude",
  harnessName: "Claude Code (Anthropic 官方 harness)",
  models: CLAUDE_MODELS,
  timeoutMs: 30 * 60 * 1000,
  buildCommand: ({ prompt, permission }) => {
    const argv = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--max-turns",
      "40"
    ];
    if (permission === "auto") argv.push("--dangerously-skip-permissions");
    return { cmd: "claude", argv };
  },
  createParser: () => {
    let textBuf = "";
    let usageBuf: Record<string, number> = {};
    return {
      onLine(line, emit) {
        if (!line.startsWith("{")) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        // 流式增量
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const d = ev.event.delta;
          if (d?.type === "text_delta" && d.text) {
            textBuf += d.text;
            emit({ type: "message", delta: d.text, text: textBuf });
          }
          return;
        }
        if (ev.type === "assistant" && ev.message) {
          for (const block of ev.message.content ?? []) {
            if (block.type === "thinking" && block.thinking) {
              emit({ type: "thinking", thinking: block.thinking });
            } else if (block.type === "text" && block.text) {
              textBuf += block.text;
              emit({ type: "message", text: textBuf });
            } else if (block.type === "tool_use") {
              emit({ type: "tool_call", tool: { id: block.id, name: block.name, input: block.input } });
            }
          }
          if (ev.message.usage) {
            for (const [k, v] of Object.entries(ev.message.usage)) {
              if (typeof v === "number") usageBuf[k] = (usageBuf[k] ?? 0) + v;
            }
            emit({
              type: "usage",
              usage: {
                inputTokens: usageBuf.input_tokens,
                outputTokens: usageBuf.output_tokens,
                cachedTokens: usageBuf.cache_read_input_tokens,
                totalTokens: usageBuf.input_tokens + usageBuf.output_tokens,
                raw: { ...usageBuf }
              }
            });
          }
        } else if (ev.type === "user" && ev.message) {
          for (const block of ev.message.content ?? []) {
            if (block.type === "tool_result") {
              const out = Array.isArray(block.content)
                ? block.content.map((c: any) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
                : String(block.content ?? "");
              emit({
                type: "tool_result",
                toolResult: { id: block.tool_use_id, name: "tool", output: out, isError: !!block.is_error }
              });
            }
          }
        } else if (ev.type === "result" && ev.subtype !== "success" && ev.result) {
          const msg = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result);
          emit({ type: "error", error: { message: msg, code: ev.subtype } });
        }
      }
    };
  },
  onExit: ({ exitCode, stderr, emitted }, emit) => {
    if (!emitted && exitCode !== 0) {
      emit({ type: "error", error: { message: stderr.trim() || "claude 运行失败", code: String(exitCode) } });
    }
  }
};
