import type { Artifact } from "@agent-router/router";
import type { Key } from "./app.js";
import type { PanelRow } from "./provider-panel.js";

export class FilesPanel {
  index = 0;
  readonly title = "任务文件";
  constructor(readonly artifacts: Artifact[], private close: () => void, private paint: () => void) {}
  get focusedRow(): number { return 3 + this.index; }
  rows(): PanelRow[] {
    return [
      { text: "当前任务记录的文件变更和产物。", tone: "muted" },
      { text: "↑↓ 浏览 · Esc 返回", tone: "muted" },
      { text: "" },
      ...(this.artifacts.length ? this.artifacts.map((artifact, i) => ({
        text: `${artifact.kind.toUpperCase()}  ${artifact.path}${artifact.added !== undefined || artifact.removed !== undefined ? `  +${artifact.added ?? 0} −${artifact.removed ?? 0}` : ""}`,
        selected: i === this.index,
        tone: "accent" as const
      })) : [{ text: "还没有记录到文件产物。", tone: "muted" as const }]),
      { text: "" },
      { text: this.artifacts.length ? `${this.artifacts.length} 个文件 · 详情来自 Agent 事件` : "文件事件会在下一次工具执行后出现在这里。", tone: "muted" }
    ];
  }
  handle(key: Key): void {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) { this.close(); return; }
    if (!this.artifacts.length) return;
    if (key.name === "up" || key.name === "down") {
      this.index = (this.index + (key.name === "up" ? -1 : 1) + this.artifacts.length) % this.artifacts.length;
      this.paint();
    }
  }
}
