/**
 * core/registry.ts — 模型 → 原生 harness 的确定性映射 + adapter 注册表。
 *
 * 核心产品决策：CLI/IDE 暴露给用户的是「模型」；选模型后由这里
 * 决定真正去跑哪个厂商的原生 agent（用户完全不感知）。
 */
import type { Adapter, ModelEntry, ApiConnection } from "@agent-router/core";

/** 模型目录：每个用户可见模型绑定一个原生 harness。 */
export const MODEL_CATALOG: ModelEntry[] = [
  {
    model: "DeepSeek V4 Flash",
    modelId: "deepseek-v4-flash",
    sourceKind: "local",
    adapterId: "dsh-acp",
    vendor: "deepseek",
    display: "快速、便宜；跑在 DeepSeek Harness 原生运行时"
  },
  {
    model: "DeepSeek V4 Pro",
    modelId: "deepseek-v4-pro",
    sourceKind: "local",
    adapterId: "dsh-acp",
    vendor: "deepseek",
    display: "DSH 原生模型；跑在 DeepSeek Harness 原生运行时"
  },
  {
    model: "GLM-5.3",
    modelId: "glm-5.3",
    sourceKind: "local",
    adapterId: "zcode",
    vendor: "zhipu",
    display: "1M 上下文长程任务；跑在 ZCode（GLM 官方 harness）"
  },
  {
    model: "Kimi K3",
    modelId: "kimi-code/k3",
    sourceKind: "local",
    adapterId: "kimi-acp",
    vendor: "moonshot",
    display: "长文档/大上下文；跑在 Kimi Code CLI（官方 harness, ACP）"
  },
  {
    model: "Claude Sonnet 4.6",
    modelId: "claude-sonnet-4-6",
    sourceKind: "local",
    adapterId: "claude-acp",
    vendor: "anthropic",
    display: "跑在 Claude Code（Anthropic 官方 harness, ACP）"
  },
  {
    model: "GPT-5.5",
    modelId: "gpt-5.5",
    sourceKind: "local",
    adapterId: "codex-acp",
    vendor: "openai",
    display: "跑在 Codex CLI（OpenAI 官方 harness, ACP）"
  },
  { model: "GPT-6 Astra", modelId: "gpt-6-astra", sourceKind: "local", adapterId: "codex-acp", vendor: "OpenAI", display: "本机 Codex · 复用登录和配置" },
  { model: "Claude Fable 5", modelId: "claude-fable-5", sourceKind: "local", adapterId: "claude-acp", vendor: "Anthropic", display: "本机 Claude Code · 复用登录和配置" },
  { model: "Claude Fable 5.1", modelId: "claude-fable-5-1", sourceKind: "local", adapterId: "claude-acp", vendor: "Anthropic", display: "2026-09 官方主力型号 · Claude Code" },
  { model: "Claude Opus 5", modelId: "claude-opus-5", sourceKind: "local", adapterId: "claude-acp", vendor: "Anthropic", display: "Claude Code · 账号权限在连接时验证" },
  { model: "Claude Sonnet 5", modelId: "claude-sonnet-5", sourceKind: "local", adapterId: "claude-acp", vendor: "Anthropic", display: "Claude Code · 账号权限在连接时验证" },
  { model: "DeepSeek V4.1 Flash", modelId: "deepseek-flash", sourceKind: "local", adapterId: "dsh-acp", vendor: "DeepSeek", display: "官方 API ID deepseek-flash · 本机 DSH 来源由原生配置决定" },
  ...["Sol", "Terra", "Luna"].map(name => ({ model: `GPT-5.6 ${name}`, modelId: `gpt-5.6-${name.toLowerCase()}`, sourceKind: "local" as const, adapterId: "codex-acp", vendor: "OpenAI", display: "Codex CLI · 账号权限在连接时验证" })),
];

/** 通过模型名查找其绑定的 harness。 */
export function adapterIdForModel(model: string): string | undefined {
  return MODEL_CATALOG.find((m) => m.model === model)?.adapterId;
}

/** 列出全部可用的用户可见模型名。 */
export function listModels(): string[] {
  return MODEL_CATALOG.map((m) => m.model);
}

/**
 * 注册表：持有全部 adapter，负责「模型 → 可用 adapter → Session」。
 */
export class Registry {
  private adapters = new Map<string, Adapter>();
  private entries = new Map(MODEL_CATALOG.map(entry => [entry.model, entry]));
  private resolveConnection?: (entry: ModelEntry) => ApiConnection | undefined;

  configure(entries: ModelEntry[], resolveConnection: (entry: ModelEntry) => ApiConnection | undefined): void {
    this.entries = new Map([...MODEL_CATALOG, ...entries].map(entry => [entry.model, entry]));
    this.resolveConnection = resolveConnection;
  }
  entry(model: string): ModelEntry | undefined { return this.entries.get(model); }
  listModels(): ModelEntry[] { return [...this.entries.values()]; }
  async availableAdapters(): Promise<Record<string, boolean>> {
    const results = await Promise.all([...this.adapters].map(async ([id, adapter]) => [id, await adapter.isAvailable().catch(() => false)] as const));
    return Object.fromEntries(results);
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** 该模型可用吗？（模型存在 且 对应 harness 本机可用） */
  async isModelAvailable(model: string): Promise<boolean> {
    const adapterId = this.entries.get(model)?.adapterId;
    if (!adapterId) return false;
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return false;
    return adapter.isAvailable();
  }

  /** 列出当前可用的模型（按目录顺序）。 */
  async listAvailableModels(): Promise<string[]> {
    const availability = await this.availableAdapters();
    return [...this.entries.values()].filter(entry => availability[entry.adapterId]).map(entry => entry.model);
  }

  /** 为一个模型创建一个会话 —— 内部自动路由到对应原生 harness。 */
  async createSession(model: string, opts: { cwd: string; permission?: "ask" | "auto"; reasoningEffort?: string }) {
    const adapterId = this.entries.get(model)?.adapterId;
    if (!adapterId) throw new Error(`未知模型: ${model}`);
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`模型 ${model} 对应的 harness 未注册: ${adapterId}`);
    if (!(await adapter.isAvailable())) {
      throw new Error(`模型 ${model} 对应的原生 harness (${adapter.harnessName}) 本机不可用`);
    }
    return adapter.createSession({
      model,
      modelId: this.entries.get(model)?.modelId ?? model,
      connection: this.resolveConnection?.(this.entries.get(model)!),
      reasoningEffort: opts.reasoningEffort,
      reasoningLevels: this.entries.get(model)?.reasoningLevels,
      cwd: opts.cwd,
      permission: opts.permission
    });
  }

  get harnessSummary(): string {
    return [...this.adapters.values()]
      .map((a) => `${a.id} → ${a.harnessName} (${a.models.join(", ")})`)
      .join("\n");
  }
}
