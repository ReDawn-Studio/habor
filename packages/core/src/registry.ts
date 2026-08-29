/**
 * core/registry.ts — 模型 → 原生 harness 的确定性映射 + adapter 注册表。
 *
 * 核心产品决策：CLI/IDE 暴露给用户的是「模型」；选模型后由这里
 * 决定真正去跑哪个厂商的原生 agent（用户完全不感知）。
 */
import type { Adapter, ModelEntry } from "./types.js";

/** 模型目录：每个用户可见模型绑定一个原生 harness。 */
export const MODEL_CATALOG: ModelEntry[] = [
  {
    model: "DeepSeek V4 Flash",
    adapterId: "dsh-acp",
    vendor: "deepseek",
    display: "快速、便宜；跑在 DeepSeek Harness 原生运行时"
  },
  {
    model: "DeepSeek V4 Pro",
    adapterId: "dsh-acp",
    vendor: "deepseek",
    display: "DSH 原生模型；跑在 DeepSeek Harness 原生运行时"
  },
  {
    model: "GLM-5.3",
    adapterId: "zcode",
    vendor: "zhipu",
    display: "1M 上下文长程任务；跑在 ZCode（GLM 官方 harness）"
  },
  {
    model: "Kimi K3",
    adapterId: "kimi-acp",
    vendor: "moonshot",
    display: "长文档/大上下文；跑在 Kimi Code CLI（官方 harness, ACP）"
  },
  {
    model: "Claude Sonnet 4.6",
    adapterId: "claude-acp",
    vendor: "anthropic",
    display: "跑在 Claude Code（Anthropic 官方 harness, ACP）"
  },
  {
    model: "GPT-5.5",
    adapterId: "codex-acp",
    vendor: "openai",
    display: "跑在 Codex CLI（OpenAI 官方 harness, ACP）"
  }
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

  register(adapter: Adapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** 该模型可用吗？（模型存在 且 对应 harness 本机可用） */
  async isModelAvailable(model: string): Promise<boolean> {
    const adapterId = adapterIdForModel(model);
    if (!adapterId) return false;
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return false;
    return adapter.isAvailable();
  }

  /** 列出当前可用的模型（按目录顺序）。 */
  async listAvailableModels(): Promise<string[]> {
    const out: string[] = [];
    for (const m of MODEL_CATALOG) {
      if (await this.isModelAvailable(m.model)) out.push(m.model);
    }
    return out;
  }

  /** 为一个模型创建一个会话 —— 内部自动路由到对应原生 harness。 */
  async createSession(model: string, opts: { cwd: string; permission?: "ask" | "auto" }) {
    const adapterId = adapterIdForModel(model);
    if (!adapterId) throw new Error(`未知模型: ${model}`);
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`模型 ${model} 对应的 harness 未注册: ${adapterId}`);
    if (!(await adapter.isAvailable())) {
      throw new Error(`模型 ${model} 对应的原生 harness (${adapter.harnessName}) 本机不可用`);
    }
    return adapter.createSession({
      model,
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
