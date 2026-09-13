/**
 * dsh-acp/dsh-runtime.ts — 在 dsh-acp 进程内 in-process 引导 DeepSeek Harness。
 *
 * 复用官方 `dsh` 安装（PATH 定位真实路径），通过 createRequire 加载
 * @deepseek-ai/* 核心包，按 headless profile 的组合方式挂载
 * dsh-base + code-runtime，然后通过核心服务创建真实 Agent。
 *
 * 参考：官方 headless runner 的实现（agents.create → followup → whenIdle →
 * session.events），但这里是长驻服务，Agent 跨多轮 prompt 存活。
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { reasoningLabel, assertReasoningLevel, dshPackageAnchor, type AgentEvent, type ReasoningCapabilities } from "@agent-router/core";

export interface DshRuntime {
  req: ReturnType<typeof createRequire>;
  ctx: any;
  dispose(): Promise<void>;
}

/** 通过 PATH 定位 dsh 安装的 package.json（createRequire 锚点）。 */
export function resolveDshInstall(): string | null {
  return dshPackageAnchor() ?? null;
}

/** in-process 引导 DSH 核心树。 */
export async function bootDsh(): Promise<DshRuntime> {
  const installAnchor = resolveDshInstall();
  if (!installAnchor) throw new Error("未找到 dsh 安装（DeepSeek Harness）。请先安装 dsh。");
  const req = createRequire(installAnchor);
  const { boot, loadProfile, healProfilesModuleFallback } = req("@deepseek-ai/dsh-app-boot");
  healProfilesModuleFallback(installAnchor);

  const profile = loadProfile("dsh", "headless", installAnchor, void 0, { userLayer: true });
  const base = profile.layers.find((l: any) => l.packageName === "@deepseek-ai/dsh-base");

  // 组合：base bundle + 复刻 headless 的覆盖行（tools mode / persona / code-runtime），
  // 但不要 headless 的 startup/runner（一次性执行者，与 ACP 长驻服务冲突）。
  const patches: any[] = [
    ...(base?.patches ?? []),
    { id: "hmr", disabled: true },
    ...(process.env.HABOR_DSH_BASE_URL ? [{ id: "agent-default-model", config: { provider: "habor-api", model: process.env.DSH_ACP_MODEL } }] : []),
    { id: "tools", config: { mode: process.env.DSH_TOOLS_MODE } },
    {
      id: "system-prompt",
      config: {
        persona:
          "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}."
      }
    },
    {
      insert: [{ id: "code-runtime", name: "@deepseek-ai/dsh-code-runtime-worker-thread" }]
    }
  ];

  const rootConfig = join(profile.dir, "cordis.yml");
  writeFileSync(rootConfig, "[]\n");

  const ctx = await boot("dsh", rootConfig, structuredClone(patches), (hostCtx: any) => {
    hostCtx.provide("dsh:launch-environment", {});
  });
  await ctx.get("loader")?.await();
  let apiRoute: (() => void) | undefined;
  if (process.env.HABOR_DSH_BASE_URL && process.env.HABOR_DSH_API_KEY) {
    const { DeepSeekAdapter, resolveAdapterOptions } = req("@deepseek-ai/dsh-llm-deepseek");
    const { getOrCreateAnonymousUserId } = req("@deepseek-ai/dsh-anonymous-user-id");
    const connection = resolveAdapterOptions({ baseURL: process.env.HABOR_DSH_BASE_URL, apiKeyEnv: "HABOR_DSH_API_KEY", models: [{ id: process.env.DSH_ACP_MODEL }] });
    apiRoute = ctx.get("llm").registerAdapter(["habor-api"], new DeepSeekAdapter({
      options: () => connection, resolveApiKey: async () => process.env.HABOR_DSH_API_KEY!,
      resolveUserId: getOrCreateAnonymousUserId, resolveAttachments: () => ctx.get("attachments")
    }));
  }

  return {
    req,
    ctx,
    async dispose() {
      apiRoute?.();
      await ctx.fiber?.dispose();
    }
  };
}

/** 用户可见模型名 → DSH provider model id（DSH 只认 id 小写形式）。 */
const MODEL_ALIASES: Record<string, string> = {
  "DeepSeek V4 Flash": "deepseek-v4-flash",
  "DeepSeek V4 Pro": "deepseek-v4-pro"
};

function resolveModelId(model: string | undefined): string {
  if (!model) return model as string;
  return MODEL_ALIASES[model] ?? model;
}

/** 一个长驻 DSH Agent 句柄（跨多轮 prompt 存活，保留会话记忆）。 */
export interface DshAgentHandle {
  agent: any;
  connection: NonNullable<AgentEvent["connection"]>;
  reasoning: ReasoningCapabilities;
  getReasoningEffort(): string | undefined;
  setReasoningEffort(effort: string | undefined): void;
  /** 提交一条用户消息（不等待） */
  followup(text: string): void;
  /** 事件日志（追加式数组，按 index 水位消费） */
  events(): any[];
  idle(): Promise<void>;
}

export interface CreateDshAgentOptions {
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  /** 审批应答器：返回 "allowed-once" | "rejected" | "unavailable" */
  onApproval?: (req: { id: string; toolName: string; callId?: string; reason?: string }) => Promise<string>;
}

export async function createDshAgent(
  runtime: DshRuntime,
  opts: CreateDshAgentOptions
): Promise<DshAgentHandle> {
  const { req, ctx } = runtime;
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  if (!agents || !defaultModel) throw new Error("DSH 核心服务未就绪");

  const { SessionId } = req("@deepseek-ai/dsh-session");
  const { createUserMessage } = req("@deepseek-ai/dsh-llm");
  const { installModelSelection } = req("@deepseek-ai/dsh-agent");

  const selection = defaultModel.currentSelection();
  const provider = process.env.HABOR_DSH_BASE_URL ? "habor-api" : process.env.DSH_ACP_PROVIDER ?? selection.provider;
  const model = resolveModelId(opts.model ?? process.env.DSH_ACP_MODEL ?? selection.model);
  const llm = ctx.get("llm");
  const modelInfo = await llm.resolveModelInfo(provider, model);
  const nativeDefault = selection.provider === provider && resolveModelId(selection.model) === model ? selection.reasoningEffort : undefined;
  const reasoning: ReasoningCapabilities = { source: "native", defaultId: nativeDefault ?? modelInfo.reasoning?.defaultEffort,
    levels: (modelInfo.reasoning?.efforts ?? []).map((level: any) => ({ id: level.id, label: reasoningLabel(level.id), description: level.description })) };
  let effort = opts.reasoningEffort;
  assertReasoningLevel(reasoning, effort);
  const modelSelection = { current: { provider, model, reasoningEffort: effort ?? nativeDefault }, assembled: undefined };
  const providerInfo = llm.listProviders().find((entry: any) => entry.id === provider);
  const configurable = llm.listConfigurableProviders().find((entry: any) => entry.provider === provider);
  // Read the public, redacted settings descriptor. Do not copy raw provider settings into ACP metadata.
  const descriptors = ctx.get("settings")?.describe({ redactSecrets: true }) ?? [];
  let config = descriptors.find((entry: any) => entry.ns === configurable?.settingsNs)?.value;
  for (const key of configurable?.settingsPath ?? []) config = config?.[key];
  let endpointHost: string | undefined;
  try { endpointHost = new URL(process.env.HABOR_DSH_BASE_URL ?? config?.baseURL).host; } catch { /* Provider may use its own default endpoint. */ }
  const connection: NonNullable<AgentEvent["connection"]> = {
    agent: "DeepSeek Harness", providerId: provider, providerName: providerInfo?.name ?? provider,
    modelId: model, endpointHost, sourceKind: process.env.HABOR_DSH_BASE_URL ? "custom" : "local"
  };

  const { agent } = await agents.create({
    sessionId: SessionId(`acp-${randomUUID().slice(0, 8)}`),
    meta: { cwd: opts.cwd },
    agentOptions: { provider, model, reasoningEffort: effort ?? nativeDefault },
    setup: (agentCtx: any) => {
      installModelSelection(agentCtx, modelSelection);
      if (opts.onApproval) {
        // 审批应答器：DSH 的 approval/request waterfall → ACP requestPermission
        agentCtx.on("approval/request", async (req: any) => {
          try {
            return await opts.onApproval?.({
              id: req.id ?? String(req.toolName),
              toolName: req.toolName ?? "tool",
              callId: req.callId,
              reason: req.reason
            });
          } catch {
            return "unavailable";
          }
        });
      }
    }
  });

  await agent.whenIdle();

  return {
    agent,
    connection,
    reasoning,
    getReasoningEffort: () => effort,
    setReasoningEffort: value => { assertReasoningLevel(reasoning, value); effort = value; modelSelection.current = { provider, model, reasoningEffort: value ?? nativeDefault }; },
    followup: (text: string) => {
      agent.followup(
        createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })
      );
    },
    events: () => agent.session.events,
    idle: () => agent.whenIdle()
  };
}
