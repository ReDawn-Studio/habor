import type { ModelEntry, SessionOptions } from "./types.js";

export interface ReasoningLevel { id: string; label: string; description?: string }
export interface ReasoningCapabilities {
  levels: ReasoningLevel[];
  defaultId?: string;
  source: "native" | "documented" | "configured" | "unknown";
}
const LABELS: Record<string, string> = {
  none: "关闭", off: "关闭", on: "开启", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "Ultra（自动委派）"
};
export function reasoningLabel(id?: string): string { return id ? LABELS[id] ?? id : "原生默认"; }
export function reasoningLevels(ids: string[]): ReasoningLevel[] {
  return [...new Set(ids)].map(id => ({ id, label: reasoningLabel(id) }));
}
export function assertReasoningLevel(capabilities: ReasoningCapabilities, effort?: string): void {
  if (effort !== undefined && !capabilities.levels.some(level => level.id === effort)) {
    throw new Error(`当前模型不支持思考强度 ${effort}。可选：${capabilities.levels.map(level => level.id).join(", ") || "仅原生默认"}；请用 /effort 重新选择。`);
  }
}
export function reasoningPreferenceKey(entry: ModelEntry): string {
  return JSON.stringify([entry.providerId ?? "local", entry.adapterId, entry.modelId ?? entry.model]);
}
export function validateReasoningDeclaration(adapterId: string, levels: string[]): void {
  const allowed = adapterId === "codex-acp" ? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] : adapterId === "claude-acp" ? ["low", "medium", "high", "xhigh", "max"] : undefined;
  const unsupported = allowed && levels.find(level => !allowed.includes(level));
  if (unsupported) throw new Error(`当前 ${adapterId === "codex-acp" ? "Codex" : "Claude Code"} 接入不能发送 ${unsupported} 档位，请使用客户端支持的原始值`);
}
/** Documented model-specific fallback. Unknown model IDs stay on native defaults. */
export function documentedReasoning(adapterId: string, modelId: string): ReasoningCapabilities {
  const model = modelId.toLowerCase();
  let ids: string[] = [];
  if (adapterId === "codex-acp") {
    if (/^gpt-(?:6-astra|5\.6-(?:sol|terra|luna))$/.test(model)) ids = ["low", "medium", "high", "xhigh", "max"];
    else if (/^gpt-(?:5\.5|5\.3-codex-spark)$/.test(model)) ids = ["low", "medium", "high", "xhigh"];
  } else if (adapterId === "claude-acp") {
    if (/^(?:claude-)?(?:fable-5(?:-1)?|opus-(?:5|4[.-][78])|sonnet-5)$/.test(model)) ids = ["low", "medium", "high", "xhigh", "max"];
    else if (/^claude-(?:opus|sonnet)-4[.-]6$/.test(model)) ids = ["low", "medium", "high", "max"];
  } else if (adapterId === "dsh-acp" && /^deepseek-(?:v4-(?:flash|pro)|flash)$/.test(model)) ids = ["off", "low", "high", "max"];
  else if (adapterId === "kimi-acp" && /^(?:kimi-code\/)?(?:kimi-)?k3(?:-256k)?$/.test(model)) ids = ["low", "high", "max"];
  return { levels: reasoningLevels(ids), source: ids.length ? "documented" : "unknown" };
}
export function configuredReasoning(opts: SessionOptions, adapterId: string): ReasoningCapabilities {
  if (opts.reasoningLevels) validateReasoningDeclaration(adapterId, opts.reasoningLevels);
  return opts.reasoningLevels ? { levels: reasoningLevels(opts.reasoningLevels), source: "configured" } : documentedReasoning(adapterId, opts.modelId ?? opts.model);
}
