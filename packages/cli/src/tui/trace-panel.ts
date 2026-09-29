import type { TurnRun } from "@agent-router/router";
import type { Key } from "./app.js";
import type { PanelRow } from "./provider-panel.js";

const statusLabel: Record<TurnRun["status"], string> = {
  in_progress: "进行中", completed: "已完成", failed: "失败", incomplete: "未完成", cancelled: "已取消"
};

export class TracePanel {
  index = 0;
  readonly title = "执行 Trace";
  constructor(readonly runs: TurnRun[], private close: () => void, private paint: () => void) {}
  get focusedRow(): number { return 3 + this.index; }
  rows(): PanelRow[] {
    const lines = this.runs.flatMap(run => [
      { text: `#${run.seq} · ${statusLabel[run.status]} · ${run.model}`, tone: run.status === "failed" ? "error" as const : run.status === "completed" ? "accent" as const : "muted" as const, selected: this.runs[this.index] === run },
      { text: `  ${formatDuration(run.elapsedMs)} · 工具 ${run.tools.length} · 文件 ${run.artifactIds.length}`, tone: "muted" as const },
      ...(run.error ? [{ text: `  ${run.error.code ? `[${run.error.code}] ` : ""}${run.error.message}`, tone: "error" as const }] : []),
      ...run.tools.slice(-3).map(tool => ({ text: `  ${tool.status === "error" ? "×" : tool.status === "cancelled" ? "–" : "✓"} ${tool.name} · ${formatDuration(tool.durationMs)}`, tone: tool.status === "error" ? "error" as const : "muted" as const }))
    ]);
    return [
      { text: "按时间查看每次回复的状态、工具和文件。", tone: "muted" },
      { text: "↑↓ 浏览 · Esc 返回", tone: "muted" },
      { text: "" },
      ...lines,
      { text: "" },
      { text: "Trace 只读；完整输出仍在对话记录中。", tone: "muted" }
    ];
  }
  handle(key: Key): void {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) { this.close(); return; }
    if (key.name === "up" || key.name === "down") {
      this.index = (this.index + (key.name === "up" ? -1 : 1) + Math.max(1, this.runs.length)) % Math.max(1, this.runs.length);
      this.paint();
    }
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
