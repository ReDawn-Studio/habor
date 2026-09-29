import type { PermissionDecision, PermissionRequest } from "@agent-router/core";
import type { Key } from "./app.js";
import type { PanelRow } from "./provider-panel.js";

/** A blocking approval surface for tools that need an explicit user decision. */
export class PermissionPanel {
  index = 0;
  readonly title = "需要你的确认";

  constructor(
    readonly request: PermissionRequest,
    private decide: (decision: PermissionDecision) => void,
    private paint: () => void
  ) {}

  get focusedRow(): number { return 5 + this.index; }

  rows(): PanelRow[] {
    const options = this.request.options.length
      ? this.request.options
      : [{ id: "allow", name: "允许一次" }, { id: "deny", name: "拒绝" }];
    return [
      { text: `工具：${this.request.toolName || "未知操作"}`, tone: "accent" },
      { text: this.request.description || "此操作需要工作区权限。", tone: "muted" },
      { text: "检查命令、文件路径和参数后再继续。", tone: "muted" },
      { text: "" },
      ...options.map((option, i) => ({ text: option.name, selected: i === this.index })),
      { text: "" },
      { text: "↑↓ 选择 · Enter 确认 · Y 允许 · N 拒绝 · Esc 取消", tone: "muted" }
    ];
  }

  handle(key: Key): void {
    const options = this.request.options.length
      ? this.request.options
      : [{ id: "allow", name: "允许一次" }, { id: "deny", name: "拒绝" }];
    if (!options.length) return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      this.decide({ allow: false, message: "用户取消" });
      return;
    }
    if (key.name === "up" || key.name === "down") {
      this.index = (this.index + (key.name === "up" ? -1 : 1) + options.length) % options.length;
      this.paint();
      return;
    }
    if (key.name === "y" && !key.ctrl) {
      const allow = options.find(option => /allow|yes|允许|继续|确认/i.test(option.id + option.name));
      if (allow) { this.decide({ allow: true, optionId: allow.id }); return; }
    }
    if (key.name === "n" && !key.ctrl) {
      const deny = options.find(option => /deny|no|拒绝|取消/i.test(option.id + option.name));
      if (deny) { this.decide({ allow: false, message: deny.name }); return; }
    }
    if (key.name === "enter" || key.name === "return") {
      const option = options[this.index];
      const allow = /allow|yes|允许|继续|确认/i.test(option.id + option.name);
      this.decide(allow ? { allow: true, optionId: option.id } : { allow: false, message: option.name });
    }
  }
}
