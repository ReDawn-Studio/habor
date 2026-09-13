import { randomUUID } from "node:crypto";
import { AGENT_NAMES, inferAgent, protocolForAgent, redactSecrets, validateProvider, type AgentKind, type ApiProtocol, type ProviderProfile } from "@agent-router/core";
import { InputEditor } from "./editor.js";
import type { Key } from "./app.js";
import { displayWidth } from "./vendor/util.js";

export const OFFICIAL_PROVIDERS = [
  { name: "OpenAI 官方 API", baseUrl: "https://api.openai.com/v1", models: "gpt-6-astra" },
  { name: "Anthropic 官方 API", baseUrl: "https://api.anthropic.com", models: "claude-fable-5" },
  { name: "DeepSeek 官方 API", baseUrl: "https://api.deepseek.com", models: "deepseek-flash" },
  { name: "Moonshot 官方 API", baseUrl: "https://api.moonshot.cn/v1", models: "kimi-k3" },
  { name: "智谱官方 API", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: "glm-5.3" }
];
const AGENTS = Object.keys(AGENT_NAMES) as AgentKind[];
const PROTOCOLS: ApiProtocol[] = ["responses", "anthropic", "openai"];
export interface PanelRow { text: string; tone?: "muted" | "error" | "accent"; selected?: boolean; cursor?: number }
export class ProviderPanel {
  stage: "home" | "official" | "form" | "route" | "levels" | "review" | "saving" = "home";
  index = 0;
  error = "";
  private id: string = randomUUID();
  private kind: "official" | "custom" = "custom";
  private fields = [new InputEditor(), new InputEditor(), new InputEditor(), new InputEditor()];
  private existing = false;
  private models: ProviderProfile["models"] = [];
  private routeIndex = 0;
  private agentIndex = -1;
  private protocol: ApiProtocol = "responses";
  private levelInput = new InputEditor();
  constructor(private profiles: ProviderProfile[], private save: (profile: ProviderProfile, key?: string, useModelId?: string) => Promise<void>, private close: (showModels: boolean) => void, private paint: () => void) {}
  get title(): string { return this.stage === "levels" ? "自定义模型思考档位" : this.stage === "home" ? "连接与提供商" : this.stage === "route" ? "选择执行 Agent" : this.stage === "review" || this.stage === "saving" ? "确认连接配置" : "添加 API 来源"; }
  get focusedRow(): number { return this.stage === "review" || this.stage === "saving" ? 4 + this.index : this.stage === "levels" ? 3 : this.stage === "form" ? 2 + this.index * 3 : this.stage === "route" ? 3 + Math.max(0, this.agentIndex) : this.index + 2; }
  rows(): PanelRow[] {
    if (this.stage === "levels") return [
      { text: this.models[this.routeIndex].id, tone: "accent" },
      { text: "仅在提供商支持的档位与自动识别不同的时候填写。", tone: "muted" },
      { text: "原始档位 ID，用逗号分隔；留空恢复自动识别", tone: "muted" },
      { text: this.levelInput.text || "例如 low, high, max", selected: true, cursor: displayWidth(this.levelInput.text.slice(0, this.levelInput.cursor)) },
      { text: "" }, { text: this.error || "Enter 保存该模型的声明 · Esc 返回", tone: this.error ? "error" : "muted" }
    ];
    if (this.stage === "home") return [
      { text: "本地来源沿用客户端登录或 Key；API 来源单独配置。", tone: "muted" }, { text: "" },
      ...["本地客户端 · 无需重复填写凭据", "+ 添加官方 API", "+ 添加自定义提供商", ...this.profiles.map(p => `${p.name} · ${p.models.length} 个模型 · 编辑`)].map((text, i) => ({ text, selected: i === this.index })),
      { text: "" }, { text: "↑↓ 选择 · Enter 打开 · Esc 返回", tone: "muted" }
    ];
    if (this.stage === "official") return [{ text: "选择官方来源，地址会自动填写。", tone: "muted" }, { text: "" }, ...OFFICIAL_PROVIDERS.map((p, i) => ({ text: p.name, selected: i === this.index })), { text: "" }, { text: "↑↓ 选择 · Enter 下一步 · Esc 返回", tone: "muted" }];
    if (this.stage === "form") {
      const labels = ["提供商名称", "API Base URL", this.existing ? "API Key（留空保留已保存的 Key）" : "API Key（输入隐藏，仅保存在本机）", "模型 ID（多个模型用英文逗号分隔）"];
      const note = this.kind === "official" && /^https:\/\/api\.deepseek\.com\/?$/.test(this.fields[1].text) ? "DeepSeek V4.1 Flash 的 API 模型 ID 为 deepseek-flash。" : "填写连接信息，下一步为每个模型确认执行 Agent。";
      return [{ text: note, tone: "muted" }, ...this.fields.flatMap((field, i) => [
        { text: labels[i], tone: "muted" as const },
        { text: i === 2 ? (field.text ? "•".repeat(Math.min(32, field.text.length)) : this.existing ? "已保存 · 输入新 Key 可替换" : "粘贴 API Key") : field.text || (i === 1 ? "https://api.example.com/v1" : i === 3 ? "gpt-6-astra, claude-fable-5" : "输入名称"), selected: i === this.index, cursor: i === 2 ? Math.min(32, field.cursor) : displayWidth(field.text.slice(0, field.cursor)) }, { text: "" }
      ]), { text: this.error || "Tab / ↑↓ 切换字段 · Enter 下一步 · Esc 返回", tone: this.error ? "error" : "muted" }];
    }
    if (this.stage === "route") return [
      { text: `模型 ${this.routeIndex + 1} / ${this.models.length}：${this.models[this.routeIndex].id}`, tone: "accent" },
      { text: this.agentIndex < 0 ? "无法识别模型家族，请明确选择 Agent。" : "模型名称只提供建议，以下绑定决定实际执行客户端。", tone: "muted" }, { text: "" },
      ...AGENTS.map((agent, i) => ({ text: AGENT_NAMES[agent], selected: i === this.agentIndex })), { text: "" },
      { text: `API 协议：${this.protocol} · ←→ 可更改`, tone: "accent" },
      { text: `思考档位：${this.models[this.routeIndex].reasoningLevels?.join(", ") ?? "自动识别"} · R 自定义`, tone: "muted" },
      { text: this.error || "↑↓ 选择 Agent · Enter 确认 · Esc 返回", tone: this.error ? "error" : "muted" }
    ];
    return [
      { text: `${this.kind === "official" ? "官方 API" : "自定义提供商"} · ${this.fields[0].text}`, tone: "accent" },
      { text: this.fields[1].text }, { text: "API Key：已填写或保留现有 Key（不会进入对话历史）", tone: "muted" }, { text: "" },
      ...this.models.map((m, i) => ({ text: `保存并使用 ${m.id} → ${AGENT_NAMES[m.agent]} · ${m.protocol}`, selected: i === this.index })),
      { text: "仅保存配置", selected: this.index === this.models.length }, { text: "" },
      { text: "保存并使用：当前任务切换到此来源，保留对话和草稿。", tone: "muted" },
      { text: this.stage === "saving" ? "正在保存并应用…" : this.error || "↑↓ 选择 · Enter 确认 · Esc 返回修改", tone: this.error ? "error" : "muted" }
    ];
  }
  handle(key: Key): void {
    if (this.stage === "saving") return;
    const name = key.name;
    if (name === "escape" || (key.ctrl && name === "c")) {
      this.error = "";
      if (this.stage === "home") { this.fields[2].set(""); this.close(false); return; }
      if (this.stage === "official" || this.stage === "form") { this.fields[2].set(""); this.stage = "home"; this.index = 0; }
      else if (this.stage === "levels") this.stage = "route";
      else if (this.stage === "route") { this.stage = "form"; this.index = 3; }
      else { this.stage = "route"; this.chooseRoute(this.models.length - 1); }
      this.paint(); return;
    }
    if (this.stage === "levels") {
      if (name === "return" || name === "enter") {
        const reasoningLevels = this.levelInput.text.trim() ? [...new Set(this.levelInput.text.split(/[,，]/).map(value => value.trim()).filter(Boolean))] : undefined;
        const model = { ...this.models[this.routeIndex], agent: AGENTS[this.agentIndex], protocol: this.protocol, reasoningLevels };
        try { validateProvider({ ...this.profile(), models: [model] }); this.models[this.routeIndex] = model; this.stage = "route"; this.error = ""; }
        catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      } else if (name === "backspace") this.levelInput.backspace();
      else if (name === "left") this.levelInput.left();
      else if (name === "right") this.levelInput.right();
      else if (key.ctrl && name === "u") this.levelInput.set("");
      else if (name === "paste" || (!key.ctrl && !key.alt && key.text)) this.levelInput.insert((key.data?.toString("utf8") ?? key.text ?? "").replace(/[\r\n]/g, ""));
      this.paint(); return;
    }
    if (this.stage === "form") { this.handleForm(key); this.paint(); return; }
    if (this.stage === "route") {
      if (name === "r" && !key.ctrl && !key.alt) {
        if (this.agentIndex < 0) this.error = "请先选择执行 Agent";
        else { this.levelInput.set(this.models[this.routeIndex].reasoningLevels?.join(", ") ?? ""); this.stage = "levels"; }
        this.paint(); return;
      }
      if (name === "up" || name === "down") {
        this.agentIndex = this.agentIndex < 0 ? (name === "up" ? AGENTS.length - 1 : 0) : (this.agentIndex + (name === "up" ? -1 : 1) + AGENTS.length) % AGENTS.length;
        this.protocol = protocolForAgent(AGENTS[this.agentIndex]);
      }
      if (name === "left" || name === "right") this.protocol = PROTOCOLS[(PROTOCOLS.indexOf(this.protocol) + (name === "left" ? 2 : 1)) % PROTOCOLS.length];
      if (name === "return" || name === "enter") {
        if (this.agentIndex < 0) this.error = "请先选择执行 Agent";
        else {
          this.models[this.routeIndex] = { ...this.models[this.routeIndex], agent: AGENTS[this.agentIndex], protocol: this.protocol };
          try { validateProvider({ ...this.profile(), models: [this.models[this.routeIndex]] }); this.error = ""; if (this.routeIndex + 1 < this.models.length) this.chooseRoute(this.routeIndex + 1); else { this.stage = "review"; this.index = 0; } }
          catch (error) { this.error = String(error instanceof Error ? error.message : error); }
        }
      }
      this.paint(); return;
    }
    if (this.stage === "review") {
      if (name === "up" || name === "down") this.index = (this.index + (name === "up" ? -1 : 1) + this.models.length + 1) % (this.models.length + 1);
      if (name === "return" || name === "enter") void this.finish();
      this.paint(); return;
    }
    const count = this.stage === "home" ? this.profiles.length + 3 : OFFICIAL_PROVIDERS.length;
    if (name === "up" || name === "down") this.index = (this.index + (name === "up" ? -1 : 1) + count) % count;
    if (name === "return" || name === "enter") {
      if (this.stage === "official") {
        const preset = OFFICIAL_PROVIDERS[this.index];
        this.begin("official", preset.name, preset.baseUrl, preset.models);
      } else if (this.index === 0) { this.close(true); return; }
      else if (this.index === 1) { this.stage = "official"; this.index = 0; }
      else if (this.index === 2) this.begin("custom", "", "", "");
      else {
        const p = this.profiles[this.index - 3]; this.begin(p.kind, p.name, p.baseUrl, p.models.map(m => m.id).join(", "));
        this.id = p.id; this.existing = true; this.models = structuredClone(p.models);
      }
    }
    this.paint();
  }
  private begin(kind: "official" | "custom", name: string, baseUrl: string, models: string): void {
    this.kind = kind; this.id = randomUUID(); this.existing = false; this.models = [];
    [name, baseUrl, "", models].forEach((text, i) => this.fields[i].set(text));
    this.stage = "form"; this.index = kind === "official" ? 2 : 0;
  }
  private handleForm(key: Key): void {
    const k = key.name, field = this.fields[this.index];
    if (k === "tab" || k === "down") this.index = (this.index + 1) % 4;
    else if (k === "shift-tab" || k === "up") this.index = (this.index + 3) % 4;
    else if (k === "return" || k === "enter") {
      if (this.index !== 3) this.index++;
      else {
        const ids = this.fields[3].text.split(/[,，]/).map(id => id.trim()).filter(Boolean);
        if (!ids.length || (!this.existing && !this.fields[2].text.trim())) { this.error = "请填写 API Key 和至少一个模型 ID"; return; }
        const prior = this.models;
        this.models = ids.map(id => prior.find(m => m.id === id) ?? { id, agent: inferAgent(id) as AgentKind, protocol: inferAgent(id) ? protocolForAgent(inferAgent(id)!) : "responses" });
        try {
          validateProvider({ ...this.profile(), models: this.models.map(m => ({ ...m, agent: m.agent ?? "codex", protocol: m.agent ? protocolForAgent(m.agent) : "responses" })) });
          this.stage = "route"; this.chooseRoute(0);
        } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      }
    } else if (k === "left") field.left();
    else if (k === "right") field.right();
    else if (k === "backspace") field.backspace();
    else if (k === "delete") field.delete();
    else if (k === "home" || (key.ctrl && k === "a")) field.home();
    else if (k === "end" || (key.ctrl && k === "e")) field.end();
    else if (key.ctrl && k === "u") field.set("");
    else if (k === "paste" || (!key.ctrl && !key.alt && key.text)) field.insert((key.data?.toString("utf8") ?? key.text ?? "").replace(/[\r\n]/g, ""));
  }
  private chooseRoute(index: number): void {
    this.routeIndex = index; this.agentIndex = AGENTS.indexOf(this.models[index].agent); this.protocol = this.models[index].protocol; this.error = "";
  }
  private profile(): ProviderProfile { return { id: this.id, name: this.fields[0].text.trim(), kind: this.kind, baseUrl: this.fields[1].text.trim().replace(/\/$/, ""), models: this.models }; }
  private async finish(): Promise<void> {
    const key = this.fields[2].text.trim() || undefined;
    this.stage = "saving"; this.paint();
    try { await this.save(this.profile(), key, this.models[this.index]?.id); this.fields[2].set(""); this.close(false); }
    catch (error) { this.error = redactSecrets(error instanceof Error ? error.message : String(error), [key ?? ""]); this.stage = "review"; this.paint(); }
  }
}
