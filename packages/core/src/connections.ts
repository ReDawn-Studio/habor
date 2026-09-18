import { validateReasoningDeclaration } from "./reasoning.js";

export type AgentKind = "codex" | "claude" | "kimi" | "zcode" | "dsh" | "gemini" | "qwen" | "grok";
export type ApiProtocol = "responses" | "anthropic" | "openai";
export type SourceKind = "local" | "official" | "custom";
export const AGENT_NAMES: Record<AgentKind, string> = { codex: "Codex", claude: "Claude Code", kimi: "Kimi Code", zcode: "ZCode", dsh: "DeepSeek Harness", gemini: "Gemini CLI", qwen: "Qwen Code", grok: "Grok Build" };
export const AGENT_ADAPTERS: Record<AgentKind, string> = { codex: "codex-acp", claude: "claude-acp", kimi: "kimi-acp", zcode: "zcode", dsh: "dsh-acp", gemini: "gemini-cli", qwen: "qwen-cli", grok: "grok-cli" };
export interface ProviderModel { id: string; agent: AgentKind; protocol: ApiProtocol; reasoningLevels?: string[] }
export interface ProviderProfile {
  id: string;
  name: string;
  kind: "official" | "custom";
  baseUrl: string;
  models: ProviderModel[];
}
/** Secret-bearing runtime object: never persist this in Task, ModelEntry or conversation data. */
export interface ApiConnection { providerId: string; name: string; baseUrl: string; protocol: ApiProtocol; apiKey: string }
export function inferAgent(model: string): AgentKind | undefined {
  const name = model.toLowerCase().replace(/[_\s]+/g, "-");
  if (/(?:^|\/)(?:gpt[-\d]|codex|o[134](?:-|$))/.test(name)) return "codex";
  if (/(?:^|\/)(?:claude|fable|opus|sonnet|haiku)/.test(name)) return "claude";
  if (/(?:^|\/)(?:kimi|k3(?:-|$))/.test(name)) return "kimi";
  if (/(?:^|\/)(?:glm|zcode)/.test(name)) return "zcode";
  if (/(?:^|\/)deepseek/.test(name)) return "dsh";
  if (/(?:^|\/)(?:gemini|google)/.test(name)) return "gemini";
  if (/(?:^|\/)(?:qwen|tongyi)/.test(name)) return "qwen";
  if (/(?:^|\/)(?:grok|xai)/.test(name)) return "grok";
  return undefined;
}
export function protocolForAgent(agent: AgentKind): ApiProtocol {
  return agent === "codex" ? "responses" : agent === "claude" ? "anthropic" : "openai";
}
export function validateProvider(profile: ProviderProfile): void {
  if (!profile.name.trim() || /[\r\n\x1b]/.test(profile.name)) throw new Error("请输入有效的提供商名称");
  let url: URL;
  try { url = new URL(profile.baseUrl); } catch { throw new Error("API 地址必须是完整的 http(s) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("API 地址只能包含协议、域名和路径，不能包含账号、Key 或查询参数");
  if (!profile.models.length) throw new Error("至少添加一个模型");
  const ids = new Set<string>();
  for (const model of profile.models) {
    if (!model.id.trim() || /[\r\n\x00-\x1f]/.test(model.id) || ids.has(model.id)) throw new Error("模型 ID 不能为空或重复");
    ids.add(model.id);
    if (model.reasoningLevels && (!Array.isArray(model.reasoningLevels) || model.reasoningLevels.some(level => typeof level !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(level) || level === "default" || level === "auto"))) throw new Error("思考强度必须填写原始档位名称，如 low, high, max；default / auto 为系统保留值");
    if (!Object.hasOwn(AGENT_ADAPTERS, model.agent)) throw new Error(`请为 ${model.id} 选择执行 Agent`);
    if (model.reasoningLevels) validateReasoningDeclaration(AGENT_ADAPTERS[model.agent], model.reasoningLevels);
    if (!["responses", "anthropic", "openai"].includes(model.protocol)) throw new Error("请选择有效的 API 协议");
    if (model.agent === "kimi" && model.protocol === "responses") throw new Error("Kimi 临时模型配置需要 openai 或 anthropic 协议");
    if ((model.agent === "codex" || model.agent === "claude" || model.agent === "dsh") && model.protocol !== protocolForAgent(model.agent)) {
      throw new Error(`${AGENT_NAMES[model.agent]} 需要 ${protocolForAgent(model.agent)} 协议，不能仅凭模型名称转换协议`);
    }
  }
}
export function redactSecrets(text: string, secrets: string[]): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text;
}
