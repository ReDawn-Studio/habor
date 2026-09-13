/** Terminal conversation view: one measured transcript, an editable draft and a command menu. */
import { basename } from "node:path";
import { toDisplayText, reasoningLabel, type ReasoningCapabilities, type ProviderProfile, type SourceKind } from "@agent-router/core";
import { Screen, makeStyle } from "./vendor/term.js";
import { displayWidth, graphemes, stripAnsi, truncateWidth, wrapText } from "./vendor/util.js";
import { renderMarkdown } from "./vendor/markdown.js";
import { InputEditor } from "./editor.js";
import { ProviderPanel } from "./provider-panel.js";
import { AgentSetupPanel } from "./agent-setup-panel.js";
import type { AuthMethod, AuthStatus } from "../agent-auth.js";

export const THEME = {
  primary: "d99a78", secondary: "c6b5ff", accent: "a5bdf7",
  error: "ef8d8d", warning: "dfbb78", success: "a3c99c", info: "9dc9ce",
  text: "e5e3df", textMuted: "96938e", background: "1b1b1b",
  backgroundPanel: "262626", backgroundElement: "30302e", border: "5e5c57",
  markdownHeading: "e5e3df", markdownLinkText: "a5bdf7", markdownCode: "d9bd94",
  markdownCodeBlock: "e5e3df", markdownBlockQuote: "96938e", markdownListItem: "d99a78",
  markdownHorizontalRule: "5e5c57", thinking: "96938e", codeBg: "262626"
};
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMMAND_HINTS: Record<string, string> = {
  "/agents": "安装与管理 Agent", "/login": "账号登录或配置 API Key",
  "/model": "选择或切换模型", "/models": "选择或切换模型", "/new": "开始新任务",
  "/status": "查看当前任务", "/tasks": "查看任务记录", "/permission": "设置权限模式",
  "/help": "命令与快捷键", "/providers": "配置官方 / 自定义 API", "/refresh": "重新检测已安装的 Agent", "/effort": "当前模型的思考强度", "/clear": "清空当前屏幕", "/quit": "退出 habor", "/exit": "退出 habor"
};
export type BlockKind = "user" | "assistant" | "tool" | "thinking" | "usage" | "system" | "error";
export interface Block {
  kind: BlockKind;
  text: string;
  meta?: { id?: string; name?: string; status?: string; delta?: string; input?: string };
}
type Segment = { text: string; style: any };
type Row = { segments: Segment[]; indent?: number; bg?: string };
export interface Key {
  name?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; text?: string; data?: Buffer;
  mouse?: { action: string };
}
export interface AppViewOptions {
  terminal: { cols: number; rows: number; paint(screen: Screen): void; copyToClipboard?(text: string): unknown };
  version: string;
  cwd?: string;
  onInput: (line: string) => Promise<void> | void;
  onComplete?: (line: string) => string[];
  onSelectModel?: (model: string) => Promise<void> | void;
  onSaveProvider?: (profile: ProviderProfile, key?: string, useModelId?: string) => Promise<void | string>;
  onOpenAgentDocs?: (model: string) => Promise<void>;
  onInstallAgent?: (model: string, onOutput: (line: string) => void, signal: AbortSignal) => Promise<string>;
  onLoginAgent?: (model: string, method: AuthMethod) => Promise<AuthStatus>;
  onInspectAgentAuth?: (model: string) => Promise<AuthStatus>;
  onGetReasoning?: () => Promise<ReasoningCapabilities>;
  onSetReasoning?: (effort: string | undefined) => Promise<void>;
  onCancelInput?: () => void;
  onExit?: () => void;
}
const seg = (text: string, fg = THEME.text, bold = false): Segment => ({ text, style: makeStyle({ fg, bold }) });
const duration = (ms: number): string => ms < 60000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;

export class AppView {
  readonly editor = new InputEditor();
  blocks: Block[] = [];
  status: "idle" | "running" = "idle";
  statusText = "";
  connectionSummary = "";
  model: string | null = null;
  taskId: string | null = null;
  scroll = 0;
  atBottom = true;
  suggestions: string[] | null = null;
  suggestionIndex = 0;
  showDetails = false;
  availableModels: string[] = [];
  externalAgentModels: string[] = [];
  providers: ProviderProfile[] = [];
  modelInfo: Record<string, { source: SourceKind; agent: string; modelId: string; adapterId?: string; installed?: boolean; nativeTerminalOnly?: boolean }> = {};
  agentSetupPanel: AgentSetupPanel | null = null;
  providerPanel: ProviderPanel | null = null;
  reasoningEffort?: string;
  reasoningByModel: Record<string, string | undefined> = {};
  reasoningPicker: { index: number; loading: boolean; saving: boolean; error: string; capabilities: ReasoningCapabilities } | null = null;
  modelPicker: { query: string; index: number; connecting: boolean; error: string; manage?: boolean } | null = null;
  permission: "ask" | "auto" = "auto";
  private spinnerT = 0;
  private startedAt = 0;
  private elapsed = 0;
  private submitting = false;
  private exitUntil = 0;
  private notice = "";
  private noticeUntil = 0;
  private maxScroll = 0;
  private transcriptH = 1;
  private cache = new WeakMap<Block, { key: string; rows: Row[] }>();

  constructor(private opts: AppViewOptions) {}
  get input(): string { return this.editor.text; }
  set input(text: string) { this.editor.set(text); }
  setModel(model: string | null): void { if (this.model !== model) this.connectionSummary = ""; this.model = model; this.statusText = ""; this.paint(); }
  setTask(taskId: string | null): void { if (this.taskId !== taskId) this.connectionSummary = ""; this.taskId = taskId; this.paint(); }
  setStatusText(text: string): void { this.statusText = text; this.paint(); }
  setModels(models: string[]): void {
    const highlighted = this.modelPicker ? this.filteredModels()[this.modelPicker.index] : undefined;
    this.availableModels = models;
    if (this.modelPicker) this.modelPicker.index = Math.max(0, this.filteredModels().indexOf(highlighted ?? this.model ?? ""));
    this.refreshSuggestions(); this.paint();
  }
  append(block: Block): void {
    block.text = toDisplayText(block.text);
    if (block.meta?.delta !== undefined) block.meta.delta = toDisplayText(block.meta.delta);
    const last = this.blocks.at(-1);
    if ((block.kind === "assistant" || block.kind === "thinking") && last?.kind === block.kind && block.meta?.delta !== undefined) {
      last.text += block.meta.delta;
    } else this.blocks.push(block);
    this.paint();
  }
  clearMessages(): void { this.blocks = []; this.connectionSummary = ""; this.scroll = 0; this.atBottom = true; this.paint(); }
  setInput(text: string): void { this.editor.set(text); this.refreshSuggestions(); this.paint(); }
  openModels(): void {
    if (this.modelPicker) return;
    if (this.status === "running" || this.submitting) { this.notify("回复结束后可切换模型，Esc 可停止当前回复"); return; }
    const current = this.availableModels.indexOf(this.model ?? "");
    this.modelPicker = { query: "", index: current >= 0 ? current : Math.max(0, this.availableModels.findIndex(model => this.modelInfo[model]?.installed !== false)), connecting: false, error: "" };
    this.suggestions = null;
    this.paint();
  }
  openAgents(): void {
    if (this.status === "running" || this.submitting || this.modelPicker?.connecting) { this.notify("请在回复结束后管理 Agent"); return; }
    this.openModels();
    if (this.modelPicker) { this.modelPicker.manage = true; this.modelPicker.query = ""; this.modelPicker.index = 0; this.paint(); }
  }
  openLogin(): void { if (this.model) this.openAgentSetup(this.model); else this.openAgents(); }

  async openReasoning(): Promise<void> {
    if (this.reasoningPicker) return;
    if (!this.model) { this.notify("先按 F2 选择模型，再调整思考强度"); return; }
    if (this.status === "running" || this.submitting || this.modelPicker?.connecting) { this.notify("当前回复结束后可调整思考强度"); return; }
    if (this.modelPicker && this.filteredModels()[this.modelPicker.index] !== this.model) { this.notify("请先按 Enter 确认模型，再按 F4 调整强度"); return; }
    this.modelPicker = null; this.suggestions = null;
    const picker = { index: 0, loading: true, saving: false, error: "", capabilities: { levels: [], source: "unknown" } as ReasoningCapabilities };
    this.reasoningPicker = picker; this.paint();
    try {
      picker.capabilities = await this.opts.onGetReasoning?.() ?? { levels: [], source: "unknown" };
      const index = picker.capabilities.levels.findIndex(level => level.id === this.reasoningEffort);
      picker.index = index < 0 ? 0 : index + 1;
      if (this.reasoningEffort && index < 0) picker.error = `保存的 ${this.reasoningEffort} 已不受支持，请重新选择`;
    } catch (error) { picker.error = error instanceof Error ? error.message : String(error); }
    picker.loading = false;
    if (this.reasoningPicker === picker) this.paint();
  }
  private handleReasoningKey(key: Key): boolean {
    const picker = this.reasoningPicker!;
    if (picker.saving) return true;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) { this.reasoningPicker = null; this.paint(); return true; }
    if (picker.loading) return true;
    const count = picker.capabilities.levels.length + 1;
    if (key.name === "up" || key.name === "down") picker.index = (picker.index + (key.name === "up" ? -1 : 1) + count) % count;
    if (key.name === "return" || key.name === "enter") {
      const effort = picker.index ? picker.capabilities.levels[picker.index - 1]?.id : undefined;
      picker.saving = true;
      void (async () => {
        try {
          if (!this.opts.onSetReasoning) throw new Error("思考强度配置服务未连接");
          await this.opts.onSetReasoning(effort);
          this.reasoningEffort = effort; this.reasoningPicker = null;
          this.notify(`思考强度：${reasoningLabel(effort)}${effort ? ` (${effort})` : ""}`);
        } catch (error) { picker.error = error instanceof Error ? error.message : String(error); picker.saving = false; this.paint(); }
      })();
    }
    this.paint(); return true;
  }

  openProviders(adapterId?: string): void {
    if (this.status === "running" || this.submitting || this.modelPicker?.connecting) { this.notify("请在当前回复结束后配置提供商"); return; }
    this.modelPicker = null; this.suggestions = null;
    this.providerPanel = new ProviderPanel(this.providers, async (profile, key, useModelId) => {
      if (!this.opts.onSaveProvider) throw new Error("当前界面未连接提供商配置服务");
      return this.opts.onSaveProvider(profile, key, useModelId);
    }, (showModels, setupModel) => {
      this.providerPanel = null;
      if (setupModel) this.openAgentSetup(setupModel);
      else if (showModels) this.openModels();
      else this.paint();
    }, () => this.paint());
    if (adapterId) this.providerPanel.startForAgent(adapterId);
    this.paint();
  }

  openAgentSetup(model: string): void {
    if (this.status === "running" || this.submitting) { this.notify("请在回复结束后管理认证"); return; }
    const info = this.modelInfo[model];
    if (!info?.adapterId) { this.notify("未检测到所需客户端，请检查安装和 PATH"); return; }
    this.modelPicker = null;
    this.agentSetupPanel = new AgentSetupPanel(model, info.adapterId, info.source !== "local", async () => {
      if (!this.opts.onOpenAgentDocs) throw new Error("安装说明服务未连接");
      await this.opts.onOpenAgentDocs(model);
    }, async () => {
      if (!this.opts.onSelectModel) throw new Error("模型选择服务未连接");
      await this.opts.onSelectModel(model);
    }, selected => { this.agentSetupPanel = null; if (!selected) this.openModels(); else this.paint(); }, () => this.paint(), {
      installed: info.installed !== false,
      nativeTerminalOnly: info.nativeTerminalOnly,
      inspect: this.opts.onInspectAgentAuth ? () => this.opts.onInspectAgentAuth!(model) : undefined,
      install: this.opts.onInstallAgent ? (onOutput, signal) => this.opts.onInstallAgent!(model, onOutput, signal) : undefined,
      login: this.opts.onLoginAgent ? method => this.opts.onLoginAgent!(model, method) : undefined,
      configureApi: info.nativeTerminalOnly ? undefined : custom => { this.agentSetupPanel = null; this.openProviders(custom ? undefined : info.adapterId); if (custom) this.providerPanel?.startCustom(info.modelId); }
    });
    void this.agentSetupPanel.inspect();
    this.paint();
  }

  private filteredModels(): string[] {
    const query = this.modelPicker?.query.trim().toLowerCase() ?? "";
    const representatives = new Map<string, string>();
    for (const model of [...this.availableModels, ...this.externalAgentModels]) {
      const id = this.modelInfo[model]?.adapterId ?? model;
      if (!representatives.has(id) || model === this.model) representatives.set(id, model);
    }
    const choices = this.modelPicker?.manage ? [...representatives.values()] : this.availableModels;
    return choices.filter(model => `${model} ${this.modelInfo[model]?.agent ?? ""}`.toLowerCase().includes(query));
  }

  private async selectModel(): Promise<void> {
    const picker = this.modelPicker;
    if (!picker || picker.connecting) return;
    const model = this.filteredModels()[picker.index];
    if (!model) return;
    if (picker.manage || this.modelInfo[model]?.installed === false) { this.openAgentSetup(model); return; }
    if (model === this.model) { this.modelPicker = null; this.paint(); return; }
    picker.connecting = true; picker.error = ""; this.paint();
    try {
      if (this.opts.onSelectModel) await this.opts.onSelectModel(model);
      else await this.opts.onInput(`/model ${model}`);
      this.modelPicker = null;
    } catch (err) {
      picker.error = err instanceof Error ? err.message : String(err);
      picker.connecting = false;
    }
    this.paint();
  }

  private handleModelKey(key: Key): boolean {
    const picker = this.modelPicker!;
    if (picker.connecting) return true;
    const k = key.name;
    if (k === "escape" || k === "f2" || (key.ctrl && k === "c")) {
      this.modelPicker = null; this.paint(); return true;
    }
    if (k === "return" || k === "enter") { void this.selectModel(); return true; }
    const matches = this.filteredModels();
    let direction = 0;
    if (k === "up" || k === "shift-tab" || (key.ctrl && k === "p") || key.mouse?.action === "wheel-up") direction = -1;
    if (k === "down" || k === "tab" || (key.ctrl && k === "n") || key.mouse?.action === "wheel-down") direction = 1;
    if (direction && matches.length) picker.index = (picker.index + direction + matches.length) % matches.length;
    else if (k === "home") picker.index = 0;
    else if (k === "end") picker.index = Math.max(0, matches.length - 1);
    else if (k === "backspace") { picker.query = graphemes(picker.query).slice(0, -1).join(""); picker.index = 0; }
    else if (key.ctrl && k === "u") { picker.query = ""; picker.index = 0; }
    else if (k === "paste" || (!key.ctrl && !key.alt && key.text)) {
      picker.query += stripAnsi(key.data?.toString("utf8") ?? key.text ?? "").replace(/[\r\n\t]/g, " ");
      picker.index = 0;
    }
    picker.error = "";
    this.paint(); return true;
  }
  setBusy(busy: boolean): void {
    if (busy && this.status === "idle") { this.startedAt = Date.now(); this.spinnerT = 0; }
    if (!busy && this.status === "running") this.elapsed = Date.now() - this.startedAt;
    this.status = busy ? "running" : "idle";
    this.paint();
  }
  notify(text: string): void { this.notice = text; this.noticeUntil = Date.now() + 3500; this.paint(); }
  tick(): void {
    if (this.status === "running" || this.agentSetupPanel?.busy) { this.spinnerT++; this.paint(); }
    else if ((this.notice && Date.now() > this.noticeUntil) || (this.exitUntil && Date.now() > this.exitUntil)) {
      this.notice = ""; this.exitUntil = 0; this.paint();
    }
  }
  private refreshSuggestions(): void {
    this.suggestions = this.input.startsWith("/") && !this.input.includes("\n") ? this.opts.onComplete?.(this.input) ?? [] : null;
    this.suggestionIndex = 0;
  }
  private scrollBy(amount: number): void {
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + amount));
    this.atBottom = this.scroll === this.maxScroll;
    this.paint();
  }
  handleKey(key: Key): boolean {
    const k = key.name;
    if (this.agentSetupPanel) { this.agentSetupPanel.handle(key); return true; }
    if (this.reasoningPicker) return this.handleReasoningKey(key);
    if (this.providerPanel) { this.providerPanel.handle(key); return true; }
    if (k === "f5") { if (this.modelPicker) { const model = this.filteredModels()[this.modelPicker.index]; if (model) this.openAgentSetup(model); } else this.openAgents(); return true; }
    if (k === "f4") { void this.openReasoning(); return true; }
    if (k === "f3") { this.openProviders(); return true; }
    if (this.modelPicker) return this.handleModelKey(key);
    if (k === "f2") { this.openModels(); return true; }
    if (k === "mouse") {
      if (key.mouse?.action === "wheel-up") this.scrollBy(-3);
      if (key.mouse?.action === "wheel-down") this.scrollBy(3);
      return true;
    }
    if (k === "pageup" || k === "pagedown") { this.scrollBy((k === "pageup" ? -1 : 1) * Math.max(1, this.transcriptH - 2)); return true; }
    if (key.ctrl && k === "o") { this.showDetails = !this.showDetails; this.paint(); return true; }
    if (key.ctrl && k === "y") {
      const answer = this.blocks.filter(b => b.kind === "assistant").at(-1);
      if (answer) { this.opts.terminal.copyToClipboard?.(answer.text); this.notify("已复制最近一段回复"); }
      return true;
    }
    if (key.ctrl && k === "c") {
      if (this.status === "running") this.opts.onCancelInput?.();
      else if (this.input) this.setInput("");
      else if (Date.now() < this.exitUntil) this.opts.onExit?.();
      else { this.exitUntil = Date.now() + 2000; this.notify("再按一次 Ctrl+C 退出 · /quit 也可退出"); }
      return true;
    }
    if (key.ctrl && k === "d" && !this.input && this.status === "idle") { this.opts.onExit?.(); return true; }
    if (k === "escape") {
      if (this.suggestions !== null) { this.suggestions = null; this.paint(); }
      else if (this.status === "running") this.opts.onCancelInput?.();
      else if (!this.atBottom) { this.scroll = this.maxScroll; this.atBottom = true; this.paint(); }
      return true;
    }
    if (k === "paste" || k === "clipboard") {
      if (key.data) this.editor.insert(key.data.toString("utf8"));
    } else if (k === "tab" || k === "shift-tab") {
      if (!this.suggestions?.length) this.refreshSuggestions();
      if (this.suggestions?.length) {
        if (k === "shift-tab") this.suggestionIndex = (this.suggestionIndex - 1 + this.suggestions.length) % this.suggestions.length;
        else this.acceptSuggestion(false);
      }
      this.paint(); return true;
    } else if ((k === "return" || k === "enter") && (key.shift || key.alt || key.ctrl)) {
      this.editor.insert("\n");
    } else if (k === "return" || k === "enter") {
      if (this.suggestions?.length) this.acceptSuggestion(true);
      else void this.submit();
      return true;
    } else if (k === "up" || k === "down" || (key.ctrl && (k === "p" || k === "n"))) {
      const direction = k === "up" || k === "p" ? -1 : 1;
      if (key.shift) { this.scrollBy(direction * 3); return true; }
      if (this.suggestions?.length) {
        this.suggestionIndex = (this.suggestionIndex + direction + this.suggestions.length) % this.suggestions.length;
        this.paint(); return true;
      }
      if (!this.editor.vertical(direction, this.contentWidth() - 4)) this.editor.recall(direction);
    } else if (k === "left" || (key.ctrl && k === "b")) this.editor.left();
    else if (k === "right" || (key.ctrl && k === "f")) this.editor.right();
    else if (k === "home" || (key.ctrl && k === "a")) this.editor.home();
    else if (k === "end" || (key.ctrl && k === "e")) this.editor.end();
    else if (k === "backspace") this.editor.backspace();
    else if (k === "delete") this.editor.delete();
    else if (key.ctrl && k === "u") this.editor.deleteBefore();
    else if (key.ctrl && k === "k") this.editor.deleteAfter();
    else if (key.ctrl && k === "w") this.editor.deleteWord();
    else if (key.ctrl && k === "l") { this.clearMessages(); return true; }
    else if (!key.ctrl && !key.alt && key.text) this.editor.insert(key.text);
    else if (!key.ctrl && !key.alt && k === "space") this.editor.insert(" ");
    else return false;
    this.exitUntil = 0;
    this.refreshSuggestions();
    this.paint();
    return true;
  }
  private acceptSuggestion(submit: boolean): void {
    const selected = this.suggestions?.[this.suggestionIndex];
    if (!selected) return;
    if (selected === "/agents" || selected === "/login") { this.editor.set(""); if (selected === "/login") this.openLogin(); else this.openAgents(); return; }
    if (selected === "/model" || selected === "/models") {
      if (this.status === "running" || this.submitting) { this.openModels(); return; }
      this.editor.set(""); this.openModels(); return;
    }
    if (selected === "/providers") { if (this.status === "idle" && !this.submitting) this.editor.set(""); this.openProviders(); return; }
    if (selected === "/effort") { if (this.status === "idle" && !this.submitting) this.editor.set(""); void this.openReasoning(); return; }
    if (selected === "/permission") { this.setInput(selected + " "); return; }
    this.editor.set(selected);
    this.suggestions = null;
    if (submit) void this.submit();
    else this.paint();
  }
  private async submit(): Promise<void> {
    const text = this.input.trim();
    if (!text) return;
    if (this.submitting || this.status === "running") { this.notify("草稿已保留，回复结束后按 Enter 发送"); return; }
    if (text === "/agents" || text === "/login") { this.editor.set(""); if (text === "/login") this.openLogin(); else this.openAgents(); return; }
    if (text === "/model" || text === "/models") { this.editor.set(""); this.openModels(); return; }
    if (text === "/providers") { this.editor.set(""); this.openProviders(); return; }
    if (text === "/effort") { this.editor.set(""); void this.openReasoning(); return; }
    this.editor.remember(text);
    this.editor.set(""); this.suggestions = null; this.atBottom = true;
    this.submitting = true;
    this.setBusy(true);
    try { await this.opts.onInput(text); }
    catch (err) { this.append({ kind: "error", text: err instanceof Error ? err.message : String(err) }); }
    finally { this.submitting = false; this.setBusy(false); }
  }
  private contentWidth(): number { return Math.max(8, Math.min(104, this.opts.terminal.cols - 4)); }
  private blockRows(block: Block, width: number): Row[] {
    const text = stripAnsi(block.text).replace(/\t/g, "  ");
    const key = JSON.stringify([text, block.kind, toDisplayText(block.meta?.status), stripAnsi(block.meta?.name), stripAnsi(block.meta?.input), width, this.showDetails]);
    const cached = this.cache.get(block);
    if (cached?.key === key) return cached.rows;
    const rows: Row[] = [];
    const plain = (body: string, fg: string, indent = 2, limit = Infinity) => {
      const lines = wrapText(body, Math.max(2, width - indent));
      for (const line of lines.slice(0, limit)) rows.push({ segments: [seg(line, fg)], indent });
      if (lines.length > limit) rows.push({ segments: [seg(`… 还有 ${lines.length - limit} 行 · Ctrl+O 展开`, THEME.textMuted)], indent });
    };
    if (block.kind === "user") {
      for (const [i, line] of wrapText(text, width - 4).entries()) rows.push({ segments: [seg(i === 0 ? "❯ " : "  ", THEME.primary, true), seg(line)], indent: 1, bg: THEME.backgroundPanel });
    } else if (block.kind === "assistant") {
      renderMarkdown(text, THEME, width - 2).forEach((line, i) => rows.push({ segments: [seg(i === 0 ? "● " : "  ", THEME.primary), ...line] }));
    } else if (block.kind === "thinking") {
      rows.push({ segments: [seg(`◌ 思考${this.showDetails ? "" : " · Ctrl+O 展开"}`, THEME.thinking)] });
      if (this.showDetails) plain(text, THEME.thinking);
    } else if (block.kind === "tool") {
      const status = block.meta?.status ?? "running";
      const color = status === "error" ? THEME.error : status === "done" ? THEME.success : THEME.warning;
      const mark = status === "running" ? "◌" : status === "error" ? "×" : status === "cancelled" ? "–" : "✓";
      rows.push({ segments: [seg(`${mark} ${stripAnsi(block.meta?.name ?? "工具")}`, color, true), seg(status === "running" ? "  执行中" : status === "cancelled" ? "  已停止" : "", THEME.textMuted)] });
      if (block.meta?.input) plain(stripAnsi(block.meta.input), THEME.textMuted, 2, this.showDetails ? Infinity : 1);
      if (text) plain(text, status === "error" ? THEME.error : THEME.textMuted, 2, this.showDetails ? Infinity : 3);
    } else if (block.kind === "usage") {
      // Token counts live in the status strip instead of breaking the conversation.
      return [];
    } else {
      plain((block.kind === "error" ? "× " : "") + text, block.kind === "error" ? THEME.error : THEME.textMuted, 0);
    }
    rows.push({ segments: [] });
    this.cache.set(block, { key, rows });
    return rows;
  }
  paint(): void {
    const { cols, rows } = this.opts.terminal;
    if (cols < 20 || rows < 10) {
      const screen = new Screen(cols, rows);
      screen.text(0, 0, truncateWidth("请放大终端窗口", cols), makeStyle({ fg: THEME.textMuted }));
      this.opts.terminal.paint(screen); return;
    }
    const screen = new Screen(cols, rows);
    screen.clear(makeStyle({ bg: THEME.background }));
    const width = this.contentWidth(), left = Math.floor((cols - width) / 2);
    const write = (y: number, text: string, fg = THEME.textMuted, x = left, max = width, bg?: string, bold = false) => {
      screen.text(x, y, truncateWidth(text, Math.max(0, max)), makeStyle({ fg, bg, bold }));
    };
    const inputLines = this.editor.lines(width - 4), caret = this.editor.position(inputLines);
    const inputH = Math.min(Math.max(1, inputLines.length), Math.max(1, Math.min(6, Math.floor(rows / 4))));
    const inputStart = Math.max(0, caret.row - inputH + 1);
    const menuH = this.suggestions !== null ? Math.min(Math.max(1, this.suggestions.length), 5, Math.max(1, rows - inputH - 9)) + 1 : 0;
    const composerTop = rows - inputH - 4;
    const menuTop = composerTop - menuH;
    const transcriptTop = 3, transcriptBottom = Math.max(transcriptTop, menuTop - 1);
    this.transcriptH = Math.max(0, transcriptBottom - transcriptTop);
    write(0, "✳ habor", THEME.primary, left, width, undefined, true);
    if (width > 40) write(0, `v${this.opts.version}  /  ${basename(this.opts.cwd ?? process.cwd())}`, THEME.textMuted, left + 10, width - 10);
    write(1, "─".repeat(width), THEME.border);

    const transcript = this.blocks.flatMap(block => this.blockRows(block, width));
    this.maxScroll = Math.max(0, transcript.length - this.transcriptH);
    this.scroll = this.atBottom ? this.maxScroll : Math.min(this.scroll, this.maxScroll);
    if (transcript.length === 0) {
      const welcome: [string, string, boolean?][] = [
        ["", THEME.text], ["准备好一起做点什么？", THEME.text, true],
        ["选择模型，开始对话。你的任务会随模型切换继续。", THEME.textMuted], ["", THEME.text],
        ["F2 或 /model      使用本地客户端，或选择已添加的模型", THEME.accent], ["F3 或 /providers  添加官方 API / 自定义提供商", THEME.accent], ["/help            查看命令与快捷键", THEME.textMuted],
        ["试试：解释这个项目的结构，找出可以改进的地方", THEME.textMuted], ["", THEME.text],
        [this.availableModels.length ? `${this.availableModels.length} 个模型可用 · ${this.availableModels.slice(0, 3).join(" / ")}` : "正在检查本机可用模型…", THEME.textMuted]
      ];
      welcome.slice(0, this.transcriptH).forEach(([text, fg, bold], i) => write(transcriptTop + i, text, fg, left + 2, width - 4, undefined, bold));
    } else {
      transcript.slice(this.scroll, this.scroll + this.transcriptH).forEach((row, i) => {
        const y = transcriptTop + i;
        if (row.bg) screen.fill(left, y, width, " ", makeStyle({ bg: row.bg }));
        let x = left + (row.indent ?? 0);
        for (const segment of row.segments) {
          const clipped = truncateWidth(segment.text, Math.max(0, left + width - x));
          x = screen.text(x, y, clipped, { ...segment.style, bg: segment.style.bg ?? row.bg ?? null });
        }
      });
    }
    if (this.suggestions !== null) {
      const visible = menuH - 1;
      const start = Math.max(0, Math.min(this.suggestionIndex - visible + 1, this.suggestions.length - visible));
      write(menuTop, this.input.startsWith("/model ") ? "选择模型 · 输入名称搜索" : "命令 · ↑↓ 选择 · Enter 确认 · Tab 补全", THEME.textMuted);
      if (!this.suggestions.length) write(menuTop + 1, "没有匹配项 · Backspace 修改 · Esc 收起", THEME.textMuted);
      this.suggestions.slice(start, start + visible).forEach((value, i) => {
        const selected = i + start === this.suggestionIndex;
        const bg = selected ? THEME.backgroundElement : undefined;
        if (bg) screen.fill(left, menuTop + i + 1, width, " ", makeStyle({ bg }));
        const label = value.startsWith("/model ") ? value.slice(7) : value;
        const current = value === `/model ${this.model}` ? "  ✓ 当前" : "";
        write(menuTop + i + 1, `${selected ? "❯" : " "} ${label}${current}`, selected ? THEME.text : THEME.textMuted, left + 1, width - 2, bg, selected);
        const hint = COMMAND_HINTS[value];
        if (hint && width >= 50) write(menuTop + i + 1, hint, THEME.textMuted, left + 20, width - 22, bg);
      });
    }
    write(composerTop, "─".repeat(width), this.status === "running" ? THEME.primary : THEME.border);
    if (!this.atBottom && transcriptBottom > transcriptTop) {
      const label = ` ↑ 正在浏览记录 · ${this.maxScroll - this.scroll} 行未显示 · Esc 回到底部 `;
      write(composerTop, label, THEME.accent);
    }
    for (let i = 0; i < inputH; i++) {
      const line = inputLines[inputStart + i];
      write(composerTop + 1 + i, i === 0 ? "❯" : "·", THEME.primary, left + 1, 1);
      write(composerTop + 1 + i, line?.text || (i === 0 && !this.input ? (this.status === "running" ? "可以继续写下一条消息…" : this.model ? "输入消息，或 / 查看命令" : "输入 /model 选择模型") : ""), this.input ? THEME.text : THEME.textMuted, left + 3, width - 4);
    }
    write(composerTop + inputH + 1, "─".repeat(width), THEME.border);
    const running = this.status === "running";
    const status = running ? `${SPINNER[this.spinnerT % SPINNER.length]} ${this.statusText || "处理中"} · ${duration(Date.now() - this.startedAt)}` : this.statusText || (this.elapsed ? `✓ 已完成 · ${duration(this.elapsed)}` : "就绪");
    const model = this.model ? `${this.model}${this.modelInfo[this.model]?.source === "local" ? " · 本机客户端" : ""}` : "未选择模型";
    const usage = stripAnsi(this.blocks.filter(b => b.kind === "usage").at(-1)?.text);
    const statusLeft = `${model}  ·  ${reasoningLabel(this.reasoningEffort)}  ·  ${status}`;
    write(rows - 2, statusLeft, running ? THEME.warning : THEME.textMuted);
    if (usage && width - displayWidth(statusLeft) > displayWidth(usage) + 3) write(rows - 2, usage, THEME.textMuted, left + width - displayWidth(usage), displayWidth(usage));
    const hint = Date.now() < this.noticeUntil ? this.notice : running ? "Esc / Ctrl+C 停止 · 可编辑草稿 · PgUp/PgDn 浏览" : this.suggestions !== null ? "↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 收起" : width < 65 ? "F2 模型 · F3 来源 · F4 思考 · F5 Agent" : "Enter 发送 · Alt+Enter 换行 · F2 模型 · F3 来源 · F4 思考 · F5 Agent";
    write(rows - 1, hint, THEME.textMuted);
    screen.cursorX = Math.min(cols - 1, left + 3 + caret.col);
    screen.cursorY = composerTop + 1 + caret.row - inputStart;
    if (this.modelPicker) this.paintModelPicker(screen);
    if (this.providerPanel || this.agentSetupPanel) this.paintProviderPanel(screen);
    if (this.reasoningPicker) this.paintReasoningPicker(screen);
    screen.defaultBackground(THEME.background);
    this.opts.terminal.paint(screen);
  }

  private paintModelPicker(screen: Screen): void {
    const picker = this.modelPicker!;
    for (const row of screen.cells) for (const cell of row) cell.style = { ...cell.style, fg: THEME.border, bold: false };
    const matches = this.filteredModels();
    const visible = Math.min(Math.max(1, matches.length), 8, Math.max(1, screen.rows - 9));
    const width = Math.min(72, screen.cols - 4), height = visible + 7;
    const left = Math.floor((screen.cols - width) / 2), top = Math.floor((screen.rows - height) / 2);
    const style = makeStyle({ fg: THEME.border, bg: THEME.backgroundPanel });
    for (let y = top; y < top + height; y++) {
      screen.fill(left, y, width, " ", style);
      screen.text(left, y, "│", style); screen.text(left + width - 1, y, "│", style);
    }
    screen.text(left, top, "╭" + "─".repeat(width - 2) + "╮", style);
    screen.text(left, top + height - 1, "╰" + "─".repeat(width - 2) + "╯", style);
    const write = (row: number, text: string, fg = THEME.textMuted, bold = false) => screen.text(left + 2, top + row, truncateWidth(text, width - 4), makeStyle({ fg, bg: THEME.backgroundPanel, bold }));
    write(1, picker.manage ? "Agent 安装与认证" : "选择模型", THEME.text, true);
    const query = truncateWidth(picker.query, width - 12);
    write(2, picker.query ? `搜索：${query}` : "搜索：直接输入可筛选，也可直接按 ↑↓", picker.query ? THEME.text : THEME.textMuted);
    const info = this.modelInfo[matches[picker.index]];
    if (info) write(3, info.nativeTerminalOnly ? `官方原生终端 · ${info.agent} · 用 /model 选择型号` : `${info.source === "local" ? "客户端已配置的登录 / Key" : info.source === "official" ? "官方 API" : "自定义 API"} → ${info.agent} · ${info.modelId}`, THEME.accent);
    const start = Math.max(0, Math.min(picker.index - visible + 1, matches.length - visible));
    if (!matches.length) write(4, this.availableModels.length ? "没有匹配模型，按 Backspace 修改搜索" : "暂无可用模型，Esc 返回", THEME.warning);
    matches.slice(start, start + visible).forEach((model, i) => {
      const selected = start + i === picker.index;
      const current = model === this.model;
      const bg = selected ? THEME.backgroundElement : THEME.backgroundPanel;
      const row = top + 4 + i;
      screen.fill(left + 1, row, width - 2, " ", makeStyle({ bg }));
      const missing = this.modelInfo[model]?.installed === false;
      screen.text(left + 2, row, `${selected ? "❯" : " "} ${truncateWidth(picker.manage ? this.modelInfo[model]?.agent ?? model : model, width - ((current || missing) && width >= 24 ? 16 : 6))}`, makeStyle({ fg: selected ? THEME.text : THEME.textMuted, bg, bold: selected }));
      if ((current || missing) && width >= 24) screen.text(left + width - 10, row, missing ? "待安装" : "✓ 当前", makeStyle({ fg: missing ? THEME.warning : THEME.success, bg }));
    });
    write(4 + visible, picker.connecting ? "正在切换模型…" : picker.error ? `切换失败：${stripAnsi(picker.error)}` : matches.length ? `${picker.index + 1} / ${matches.length} 个模型 · 思考：${reasoningLabel(this.reasoningByModel[matches[picker.index]])}` : "搜索可留空，无需输入完整模型名称", picker.error ? THEME.error : picker.connecting ? THEME.warning : THEME.textMuted);
    write(5 + visible, picker.manage ? "↑↓ 选择 · Enter 安装 / 登录 / Key · Esc 返回" : info?.installed === false ? "Enter 安装 Agent · F3 配置来源 · Esc 返回" : "↑↓ 选择 · Enter 确认 · F3 来源 · F5 管理 Agent");
    screen.cursorX = Math.min(left + width - 3, left + 8 + displayWidth(query));
    screen.cursorY = top + 2;
  }

  private paintReasoningPicker(screen: Screen): void {
    const picker = this.reasoningPicker!, capabilities = picker.capabilities;
    const choices = [{ id: undefined, label: "原生默认", description: "沿用此模型的原生客户端 / 提供商配置" }, ...capabilities.levels];
    const visible = Math.min(choices.length, Math.max(1, screen.rows - 11));
    const width = Math.min(84, screen.cols - 4), height = visible + 9;
    const left = Math.floor((screen.cols - width) / 2), top = Math.floor((screen.rows - height) / 2);
    const style = makeStyle({ fg: THEME.border, bg: THEME.backgroundPanel });
    for (const row of screen.cells) for (const cell of row) cell.style = { ...cell.style, fg: THEME.border, bold: false };
    for (let y = top; y < top + height; y++) { screen.fill(left, y, width, " ", style); screen.text(left, y, "│", style); screen.text(left + width - 1, y, "│", style); }
    screen.text(left, top, "╭" + "─".repeat(width - 2) + "╮", style); screen.text(left, top + height - 1, "╰" + "─".repeat(width - 2) + "╯", style);
    const write = (y: number, text: string, fg = THEME.textMuted) => screen.text(left + 2, top + y, truncateWidth(text, width - 4), makeStyle({ fg, bg: THEME.backgroundPanel }));
    write(1, `思考强度 · ${this.model}`, THEME.text);
    write(2, "只列出当前模型的可用档位；不同模型的同名档位不等价。");
    const source = { native: "原生客户端", documented: "型号文档", configured: "提供商配置", unknown: "未提供档位信息" }[capabilities.source];
    write(3, picker.loading ? "正在读取模型能力…" : `来源：${source}${capabilities.defaultId ? ` · 默认参考：${capabilities.defaultId}` : ""}`, THEME.accent);
    const start = Math.max(0, Math.min(picker.index - visible + 1, choices.length - visible));
    choices.slice(start, start + visible).forEach((choice, i) => {
      const selected = start + i === picker.index, bg = selected ? THEME.backgroundElement : THEME.backgroundPanel;
      screen.fill(left + 1, top + 4 + i, width - 2, " ", makeStyle({ bg }));
      screen.text(left + 2, top + 4 + i, truncateWidth(`${selected ? "❯" : " "} ${choice.label}${choice.id ? ` (${choice.id})` : ""}${choice.id === this.reasoningEffort ? "  ✓ 当前" : ""}`, width - 4), makeStyle({ fg: selected ? THEME.text : THEME.textMuted, bg, bold: selected }));
    });
    write(4 + visible, choices[picker.index]?.description ?? "按该客户端的原始参数发送，不自动换算为其他档位。");
    write(5 + visible, picker.saving ? "正在应用并保存…" : picker.error || (capabilities.levels.length ? "按提供商和模型分别保存；切换模型时自动恢复。" : "未确认支持的模型仅使用原生默认。"), picker.error ? THEME.error : THEME.textMuted);
    write(7 + visible, "↑↓ 选择 · Enter 确认 · Esc 返回");
    screen.cursorX = left + 3; screen.cursorY = top + 4 + picker.index - start;
  }

  private paintProviderPanel(screen: Screen): void {
    const panel = (this.agentSetupPanel ?? this.providerPanel)!;
    const content = panel.rows().map(row => ({ ...row, text: stripAnsi(row.text).replace(/[\r\n\t]+/g, " · ") }));
    const width = Math.min(86, screen.cols - 4), height = Math.min(screen.rows - 2, content.length + 4);
    const left = Math.floor((screen.cols - width) / 2), top = Math.floor((screen.rows - height) / 2);
    for (const row of screen.cells) for (const cell of row) cell.style = { ...cell.style, fg: THEME.border, bold: false };
    const style = makeStyle({ fg: THEME.border, bg: THEME.backgroundPanel });
    for (let y = top; y < top + height; y++) { screen.fill(left, y, width, " ", style); screen.text(left, y, "│", style); screen.text(left + width - 1, y, "│", style); }
    screen.text(left, top, "╭" + "─".repeat(width - 2) + "╮", style);
    screen.text(left, top + height - 1, "╰" + "─".repeat(width - 2) + "╯", style);
    screen.text(left + 2, top + 1, panel.title, makeStyle({ fg: THEME.text, bg: THEME.backgroundPanel, bold: true }));
    const visible = height - 4, start = Math.max(0, Math.min(panel.focusedRow - visible + 2, content.length - visible));
    content.slice(start, start + visible).forEach((row, i) => {
      const bg = row.selected ? THEME.backgroundElement : THEME.backgroundPanel;
      screen.fill(left + 1, top + 3 + i, width - 2, " ", makeStyle({ bg }));
      screen.text(left + 2, top + 3 + i, truncateWidth(`${row.selected ? "❯ " : "  "}${row.text}`, width - 4), makeStyle({ fg: row.tone === "error" ? THEME.error : row.tone === "accent" ? THEME.accent : row.tone === "muted" ? THEME.textMuted : THEME.text, bg, bold: row.selected }));
      if (row.selected) { screen.cursorX = Math.min(left + width - 3, left + 4 + (row.cursor ?? 0)); screen.cursorY = top + 3 + i; }
    });
  }
}
