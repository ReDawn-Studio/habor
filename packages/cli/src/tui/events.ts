import type { AgentEvent } from "@agent-router/core";
import { normalizeEventText } from "@agent-router/core";
import type { AppView, Block } from "./app.js";
import { formatTokens, toolSummary } from "./vendor/util.js";

/** One projector per turn. Tools are matched by id even when results arrive out of order. */
export class TurnEvents {
  private tools = new Map<string, Block>();
  private accumulated = "";
  failed = false;
  constructor(private view: AppView) {}

  accept(ev: AgentEvent): void {
    ev = normalizeEventText(ev);
    switch (ev.type) {
      case "connection": {
        const connection = ev.connection;
        if (!connection) break;
        const summary = `实际连接：${connection.agent} · ${connection.providerName}${connection.endpointHost ? ` (${connection.endpointHost})` : ""} · ${connection.modelId}`;
        if (this.view.connectionSummary !== summary) {
          this.view.connectionSummary = summary;
          this.view.append({ kind: "system", text: summary });
        }
        break;
      }
      case "message": {
        let delta = ev.delta;
        if (delta === undefined) {
          const text = ev.text ?? "";
          delta = text.startsWith(this.accumulated) ? text.slice(this.accumulated.length) : text;
        }
        this.accumulated += delta;
        if (delta) this.view.append({ kind: "assistant", text: delta, meta: { delta } });
        this.view.setStatusText("正在回复");
        break;
      }
      case "thinking":
        if (ev.thinking) this.view.append({ kind: "thinking", text: ev.thinking, meta: { delta: ev.thinking } });
        this.view.setStatusText("正在思考");
        break;
      case "tool_call": {
        const tool = ev.tool;
        if (!tool) break;
        const existing = this.tools.get(tool.id);
        if (existing) {
          existing.meta = { ...existing.meta, name: tool.name, input: toolSummary(tool.name, tool.input) };
          this.view.paint();
        } else {
          const block: Block = { kind: "tool", text: "", meta: { id: tool.id, name: tool.name, input: toolSummary(tool.name, tool.input), status: "running" } };
          this.tools.set(tool.id, block);
          this.view.append(block);
        }
        this.view.setStatusText(`执行 ${tool.name}`);
        break;
      }
      case "tool_result": {
        const result = ev.toolResult;
        if (!result) break;
        let block = this.tools.get(result.id);
        if (!block) {
          block = { kind: "tool", text: "", meta: { id: result.id, name: result.name } };
          this.tools.set(result.id, block);
          this.view.append(block);
        }
        if (result.output) block.text = result.output;
        block.meta = { ...block.meta, status: result.isError ? "error" : result.status ?? "done" };
        this.view.paint();
        break;
      }
      case "usage": {
        const usage = ev.usage;
        if (!usage) break;
        const parts = [usage.inputTokens != null ? `↑ ${formatTokens(usage.inputTokens)}` : "", usage.outputTokens != null ? `↓ ${formatTokens(usage.outputTokens)}` : ""].filter(Boolean);
        const raw = usage.raw as { used?: number; size?: number } | undefined;
        if (!parts.length && raw?.used != null) parts.push(`上下文 ${formatTokens(raw.used)}${raw.size ? ` / ${formatTokens(raw.size)}` : ""}`);
        if (parts.length) this.view.append({ kind: "usage", text: parts.join("  ") });
        break;
      }
      case "file_change":
        if (ev.file) this.view.append({ kind: "system", text: `↳ ${ev.file.path}  +${ev.file.added ?? 0} −${ev.file.removed ?? 0}` });
        break;
      case "terminal":
        if (ev.terminal?.output) this.view.append({ kind: "tool", text: ev.terminal.output, meta: { name: ev.terminal.command ?? "终端输出", status: "done" } });
        break;
      case "permission":
        if (ev.permission) this.view.append({ kind: "system", text: `需要确认：${ev.permission.description}` });
        break;
      case "error":
        this.failed = true;
        this.view.append({ kind: "error", text: ev.error?.message ?? "发生错误，请重试" });
        break;
    }
  }
  finish(cancelled = false): void {
    for (const block of this.tools.values()) {
      if (block.meta?.status === "running") block.meta.status = cancelled ? "cancelled" : this.failed ? "error" : "done";
    }
    this.view.paint();
  }
}
