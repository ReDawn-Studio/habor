import type { Key } from "./app.js";
import type { PanelRow } from "./provider-panel.js";

export class WorkspaceTrustPanel {
  index = 0;
  busy = false;
  error = "";
  readonly title = "工作区信任";
  constructor(readonly cwd: string, private approve: () => Promise<void>, private deny: () => void, private cancel: () => void, private paint: () => void) {}
  get focusedRow(): number { return 7 + this.index; }
  rows(): PanelRow[] {
    return [
      { text: "Do you trust the files in this folder?", tone: "accent" },
      { text: this.cwd, tone: "accent" },
      { text: "Agent 可能读取此目录中的文件。读取不可信文件可能影响模型行为。", tone: "muted" },
      { text: "获得许可后，Agent 可能执行文件和命令；不可信代码可能带来风险。", tone: "muted" },
      { text: "" },
      { text: "首次进入工作区时确认；选择信任后仅对该目录记录。", tone: "muted" },
      { text: "" },
      { text: "是，继续", selected: this.index === 0 },
      { text: "否，退出", selected: this.index === 1 },
      { text: this.busy ? "正在保存工作区信任…" : this.error || "↑↓ 选择 · Enter 确认 · Esc 返回", tone: this.error ? "error" : "muted" }
    ];
  }
  handle(key: Key): void {
    if (this.busy) return;
    if (key.name === "escape") { this.cancel(); return; }
    if (key.name === "up" || key.name === "down") this.index = (this.index + (key.name === "up" ? 1 : -1) + 2) % 2;
    if (key.name === "enter" || key.name === "return") void this.accept();
    this.paint();
  }
  private async accept(): Promise<void> {
    if (this.index === 1) { this.deny(); return; }
    this.busy = true; this.error = ""; this.paint();
    try { await this.approve(); } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.busy = false; this.paint(); }
  }
}
