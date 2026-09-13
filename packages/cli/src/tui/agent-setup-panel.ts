import type { Key } from "./app.js";
import type { PanelRow } from "./provider-panel.js";
import { AGENT_SETUP } from "../agent-setup.js";
import { AUTH_ACTIONS, type AuthMethod, type AuthStatus } from "../agent-auth.js";
import { installPlan } from "../agent-installer.js";
import { AGENT_RUNTIMES } from "@agent-router/core";

export interface AgentLifecycle {
  installed: boolean;
  nativeTerminalOnly?: boolean;
  inspect?: () => Promise<AuthStatus>;
  install?: (onOutput: (line: string) => void, signal: AbortSignal) => Promise<string>;
  login?: (method: AuthMethod) => Promise<AuthStatus>;
  configureApi?: (custom?: boolean) => void;
}

export class AgentSetupPanel {
  index = 0;
  busy = false;
  error = "";
  notice = "";
  stage: "overview" | "install-review" | "installing" = "overview";
  installed: boolean;
  auth: AuthStatus = { state: "unknown", text: "认证状态尚未检测" };
  logs: string[] = [];
  private installStartedAt = 0;
  private operation?: AbortController;
  get title(): string { return this.stage === "install-review" ? "确认安装 Agent" : this.stage === "installing" ? "正在安装 Agent" : this.installed ? "Agent 与认证" : "安装所需 Agent"; }
  constructor(readonly model: string, private adapterId: string, private apiSource: boolean,
    private openDocs: () => Promise<void>, private retry: () => Promise<void>,
    private close: (selected: boolean) => void, private paint: () => void, private lifecycle?: AgentLifecycle) { this.installed = lifecycle?.installed ?? false; }
  get actions(): Array<{ id: string; label: string }> {
    const install = this.lifecycle?.install && AGENT_RUNTIMES[this.adapterId]?.package ? [{ id: "install", label: this.installed ? "安装 / 更新 habor 托管版本" : "自动安装官方 Agent" }] : [];
    if (!this.installed) return [...install, ...(!install.length ? [{ id: "docs", label: "打开官方安装页" }] : []), { id: "use", label: "已安装，重新检测并使用" }, ...(install.length ? [{ id: "docs", label: "打开官方安装页" }] : []), ...(this.lifecycle?.configureApi ? [{ id: "api", label: "先配置官方 API Key" }, { id: "custom-api", label: "配置第三方 / 自定义来源" }] : []), { id: "back", label: "返回模型列表" }];
    return [{ id: "use", label: this.lifecycle?.nativeTerminalOnly ? "打开原生终端（独立会话）" : this.apiSource ? "使用已保存的 API 连接" : "使用原生客户端现有认证" },
      ...(!this.apiSource && this.lifecycle?.login ? (AUTH_ACTIONS[this.adapterId] ?? []).map(action => ({ id: action.id, label: action.label })) : []),
      ...(this.lifecycle?.configureApi ? [{ id: "api", label: "填写官方 API Key" }, { id: "custom-api", label: "配置第三方 / 自定义来源" }] : []), ...install,
      { id: "docs", label: "打开官方安装说明" }, { id: "back", label: "返回模型列表" }];
  }
  async inspect(): Promise<void> {
    if (!this.installed || this.apiSource || !this.lifecycle?.inspect) return;
    try { this.auth = await this.lifecycle.inspect(); } catch { this.auth = { state: "unknown", text: "无法确认认证状态，可重新登录" }; }
    this.paint();
  }
  get focusedRow(): number { return this.stage === "overview" ? 8 + this.index : this.rows().length - 2; }
  rows(): PanelRow[] {
    const guide = AGENT_SETUP[this.adapterId];
    if (this.stage !== "overview") {
      const plan = installPlan(this.adapterId);
      return [
        { text: `${guide?.name ?? this.adapterId} · 官方 npm 包`, tone: "accent" },
        { text: `npm install ${plan.package}@${plan.version} ${plan.flags.join(" ")}`.trim() },
        { text: "来源：https://registry.npmjs.org", tone: "muted" },
        { text: `安装到：${plan.root}`, tone: "muted" },
        { text: plan.version === "latest" ? "仅启用校验成功的新版本；不修改系统全局安装。" : `按 ${plan.version} 及其兼容依赖安装；模型版本独立选择。`, tone: "muted" },
        { text: "" },
        ...(this.stage === "installing" ? this.logs.slice(-6).map(text => ({ text, tone: "muted" as const })) : [{ text: "安装完成后选择账号登录或 API Key。", tone: "muted" as const }]),
        { text: "" }, { text: this.stage === "installing" ? `安装与校验中 · ${Math.floor((Date.now() - this.installStartedAt) / 1000)}s · Esc / Ctrl+C 取消` : "Enter 开始安装 · Esc 返回", selected: this.stage === "install-review" }
      ];
    }
    return [
      { text: this.model, tone: "accent" },
      { text: `客户端：${this.installed ? "已检测到" : "未检测到"} ${guide?.name ?? this.adapterId}`, tone: this.installed ? "accent" : "error" },
      { text: this.apiSource ? "连接配置已保存；API Key 不需要重新填写。" : this.installed ? this.auth.text : "本地来源：安装后，先在原生客户端完成登录或 API 配置。", tone: "muted" },
      { text: this.lifecycle?.nativeTerminalOnly ? "独立会话：尚未接入 habor 的上下文与消息流；退出后返回原任务。" : this.installed ? "账号授权在原生终端完成；结束后回到 habor。" : "模型由远端 API 提供，Agent 负责读写文件、工具和任务执行。", tone: "muted" },
      { text: guide?.url ?? "暂无官方安装说明", tone: "accent" },
      { text: guide?.detection ?? "", tone: "muted" },
      { text: AUTH_ACTIONS[this.adapterId]?.find(action => action.id === this.actions[this.index]?.id)?.description ?? (this.lifecycle?.install ? "habor 托管安装无需重启；外部安装改变 PATH 时需重启。" : "若安装程序更新了 PATH，请退出后重新启动 habor。"), tone: "muted" },
      { text: "" },
      ...this.actions.map((action, i) => ({ text: action.label, selected: i === this.index })),
      { text: "" },
      { text: this.busy ? "正在处理…" : this.error || this.notice || "↑↓ 选择 · Enter 确认 · Esc 返回", tone: this.error ? "error" : "muted" }
    ];
  }
  handle(key: Key): void {
    if (this.busy) { if (key.name === "escape" || (key.ctrl && key.name === "c")) this.operation?.abort(); return; }
    if (this.stage === "install-review") {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) { this.stage = "overview"; this.paint(); }
      if (key.name === "return" || key.name === "enter") void this.install();
      return;
    }
    if (key.name === "escape" || (key.ctrl && key.name === "c")) { this.close(false); return; }
    if (key.name === "up" || key.name === "down" || key.name === "tab") this.index = (this.index + (key.name === "up" ? this.actions.length - 1 : 1)) % this.actions.length;
    if (key.name === "return" || key.name === "enter") void this.accept();
    this.paint();
  }
  private async accept(): Promise<void> {
    const action = this.actions[this.index]?.id;
    if (action === "back") { this.close(false); return; }
    if (action === "install") { this.stage = "install-review"; this.paint(); return; }
    if (action === "api" || action === "custom-api") { this.lifecycle?.configureApi?.(action === "custom-api"); return; }
    this.busy = true; this.error = ""; this.notice = ""; this.paint();
    try {
      if (action === "docs") { await this.openDocs(); this.notice = "安装说明已打开，完成后选择“重新检测并使用”。"; this.index = this.actions.findIndex(action => action.id === "use"); }
      else if (action === "use") { await this.retry(); this.close(true); }
      else if (action && this.lifecycle?.login) { this.auth = await this.lifecycle.login(action as AuthMethod); this.notice = this.auth.text; this.index = 0; }
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.paint(); }
  }
  private async install(): Promise<void> {
    this.busy = true; this.stage = "installing"; this.logs = []; this.error = "";
    this.installStartedAt = Date.now();
    this.operation = new AbortController(); this.paint();
    try {
      const version = await this.lifecycle!.install!(line => { this.logs.push(line); this.logs = this.logs.slice(-6); this.paint(); }, this.operation.signal);
      this.installed = true; this.index = 0; this.notice = `已安装 ${version}，请选择认证方式或使用已保存的 API 连接。`;
      await this.inspect();
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.operation = undefined; this.busy = false; this.stage = "overview"; this.paint(); }
  }
}
