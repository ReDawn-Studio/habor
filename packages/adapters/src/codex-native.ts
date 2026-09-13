import { randomUUID } from "node:crypto";
import { AGENT_NAMES, describeAgentError, toDisplayText, configuredReasoning, assertReasoningLevel, reasoningLabel, type ReasoningCapabilities, type Adapter, type AgentEvent, type Session, type SessionOptions } from "@agent-router/core";
import { hasCommand } from "./base.js";
import { NativeRpc, EventQueue } from "./rpc.js";

export function codexLaunch(opts: SessionOptions): { argv: string[]; env: NodeJS.ProcessEnv } {
  const argv = ["app-server", "-c", `model=${JSON.stringify(opts.modelId ?? opts.model)}`];
  const env = { ...process.env };
  if (opts.connection) {
    const api = opts.connection;
    if (api.protocol !== "responses") throw new Error("Codex 需要 Responses API；请检查提供商协议");
    env.HABOR_PROVIDER_KEY = api.apiKey;
    const config: Record<string, string | boolean> = {
      model_provider: "habor", "model_providers.habor.name": api.name,
      "model_providers.habor.base_url": api.baseUrl, "model_providers.habor.env_key": "HABOR_PROVIDER_KEY",
      "model_providers.habor.wire_api": "responses", "model_providers.habor.requires_openai_auth": false,
      "model_providers.habor.supports_websockets": false
    };
    for (const [key, value] of Object.entries(config)) argv.push("-c", `${key}=${JSON.stringify(value)}`);
  }
  return { argv, env };
}

class CodexSession implements Session {
  readonly id = `codex-${randomUUID()}`;
  readonly adapterId = "codex-acp";
  private rpc?: NativeRpc;
  private threadId?: string;
  private turnId?: string;
  private queue?: EventQueue<AgentEvent>;
  private streamed = new Set<string>();
  private reportedErrors = new Set<string>();
  private closing = false;
  private reasoning?: ReasoningCapabilities;
  private defaultEffort?: string;
  constructor(private opts: SessionOptions) {}
  get model(): string { return this.opts.model; }
  get cwd(): string { return this.opts.cwd; }
  private emit(event: Omit<AgentEvent, "ts" | "model" | "adapterId" | "sessionId">): void {
    this.queue?.push({ ...event, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model });
  }
  private reportError(error: unknown): void {
    const details = describeAgentError(error, [this.opts.connection?.apiKey ?? ""]);
    const fingerprint = JSON.stringify(details);
    if (this.reportedErrors.has(fingerprint)) return;
    this.reportedErrors.add(fingerprint);
    this.emit({ type: "error", error: details });
  }
  async getReasoningCapabilities(): Promise<ReasoningCapabilities> { return this.loadReasoning(this.rpc); }
  private async loadReasoning(activeRpc?: NativeRpc): Promise<ReasoningCapabilities> {
    if (this.reasoning) return this.reasoning;
    if (this.opts.connection || this.opts.reasoningLevels) return this.reasoning = configuredReasoning(this.opts, this.adapterId);
    let rpc = activeRpc;
    try {
      if (!rpc) {
        const launch = codexLaunch(this.opts);
        rpc = new NativeRpc(process.env.HABOR_CODEX_BIN ?? "codex", launch.argv, this.cwd, launch.env);
        await rpc.request("initialize", { clientInfo: { name: "habor-reasoning", version: "0.4.0" }, capabilities: { experimentalApi: false } });
        rpc.notify("initialized");
      }
      const catalog = await rpc.request("model/list", {}, 10000);
      const model = catalog.data?.find((model: any) => model.model === (this.opts.modelId ?? this.model));
      if (!Array.isArray(model?.supportedReasoningEfforts)) return this.reasoning = configuredReasoning(this.opts, this.adapterId);
      this.reasoning = { source: "native", defaultId: model.defaultReasoningEffort,
        levels: model.supportedReasoningEfforts.filter((item: any) => typeof item.reasoningEffort === "string").map((item: any) => ({ id: item.reasoningEffort, label: reasoningLabel(item.reasoningEffort), description: item.description })) };
      return this.reasoning!;
    } finally { if (rpc && !activeRpc) rpc.close(); }
  }
  async setReasoningEffort(effort: string | undefined): Promise<void> {
    assertReasoningLevel(await this.getReasoningCapabilities(), effort);
    this.opts.reasoningEffort = effort;
  }
  private async connect(): Promise<void> {
    if (this.rpc && this.threadId) return;
    this.closing = false;
    const launch = codexLaunch(this.opts);
    this.rpc = new NativeRpc(process.env.HABOR_CODEX_BIN ?? "codex", launch.argv, this.cwd, launch.env, [this.opts.connection?.apiKey ?? ""]);
    this.rpc.onNotification = (method, params) => this.notification(method, params ?? {});
    this.rpc.onClose = error => { if (!this.closing) this.reportError(error); this.queue?.finish(); this.rpc = undefined; this.threadId = undefined; };
    this.rpc.onRequest = async (method, params) => {
      if (method.endsWith("requestApproval")) {
        const decision = this.opts.permission === "auto" ? { allow: true } : await this.opts.onPermission?.({ id: params.itemId ?? randomUUID(), toolName: params.command ?? "Codex", description: params.reason ?? params.command ?? "请求执行操作", options: [{ id: "accept", name: "允许一次" }, { id: "decline", name: "拒绝" }] });
        return { decision: decision?.allow ? "accept" : "decline" };
      }
      if (method === "item/tool/requestUserInput") return { answers: {} };
      throw new Error(`Codex 请求需要客户端支持：${method}`);
    };
    await this.rpc.request("initialize", { clientInfo: { name: "habor", version: "0.3.0" }, capabilities: { experimentalApi: false } });
    this.rpc.notify("initialized");
    if (this.opts.reasoningEffort !== undefined) assertReasoningLevel(await this.loadReasoning(this.rpc), this.opts.reasoningEffort);
    const modelId = this.opts.modelId ?? this.model;
    const result = await this.rpc.request("thread/start", {
      model: modelId, ...(this.opts.connection ? { modelProvider: "habor" } : {}), cwd: this.cwd,
      approvalPolicy: this.opts.permission === "auto" ? "never" : "on-request", sandbox: "workspace-write"
    });
    if (result.model !== modelId) {
      const error = new Error(`Codex 返回的模型是 ${result.model ?? "未知"}，与选择的 ${modelId} 不一致；已停止发送，请检查模型 ID 和客户端版本`);
      this.reportError(error);
      await this.close();
      throw error;
    }
    this.threadId = result.thread.id;
    this.defaultEffort = result.reasoningEffort ?? this.reasoning?.defaultId;
  }
  private notification(method: string, params: any): void {
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (method === "item/agentMessage/delta") {
      this.streamed.add(params.itemId);
      this.emit({ type: "message", delta: toDisplayText(params.delta) });
    } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.emit({ type: "thinking", thinking: toDisplayText(params.delta) });
    } else if (method === "item/started" || method === "item/completed") {
      const item = params.item ?? {}, done = method === "item/completed";
      if (item.type === "agentMessage" && done && !this.streamed.has(item.id)) this.emit({ type: "message", delta: toDisplayText(item.text) });
      else if (["commandExecution", "mcpToolCall", "fileChange", "webSearch"].includes(item.type)) {
        const name = item.type === "commandExecution" ? "Shell" : item.type === "fileChange" ? "Edit" : item.tool ?? "Search";
        if (!done) this.emit({ type: "tool_call", tool: { id: item.id, name, input: item.command ?? item.arguments ?? item.changes ?? item.query } });
        else this.emit({ type: "tool_result", toolResult: { id: item.id, name, output: toDisplayText(item.aggregatedOutput ?? item.result ?? item.error ?? item.changes ?? ""), isError: item.status === "failed" || (item.exitCode != null && item.exitCode !== 0) } });
      }
    } else if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage?.last ?? params.tokenUsage?.total;
      if (usage) this.emit({ type: "usage", usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedInputTokens } });
    } else if (method === "error") {
      if (!params.willRetry) this.reportError(params.error ?? params);
    } else if (method === "turn/completed") {
      if (params.turn?.error) this.reportError(params.turn.error);
      this.queue?.finish();
    }
  }
  async *prompt(input: string): AsyncIterable<AgentEvent> {
    this.queue = new EventQueue(); this.streamed.clear(); this.reportedErrors.clear();
    try {
      await this.connect();
      const effort = this.opts.reasoningEffort ?? this.defaultEffort;
      const result = await this.rpc!.request("turn/start", { threadId: this.threadId, model: this.opts.modelId ?? this.model, ...(effort ? { effort } : {}), input: [{ type: "text", text: input }] });
      this.turnId = result.turn.id;
      for await (const event of this.queue) yield event;
    } catch (error) { this.reportError(error); if (!this.threadId && this.rpc) await this.close(); this.queue.finish(); for await (const event of this.queue) yield event; }
    finally { this.turnId = undefined; this.queue.finish(); }
    yield { type: "done", ts: Date.now(), model: this.model, adapterId: this.adapterId, sessionId: this.id };
  }
  async cancel(): Promise<void> {
    if (this.rpc && this.threadId && this.turnId) await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 2000).catch(() => {});
    this.queue?.finish();
  }
  async close(): Promise<void> { this.closing = true; this.queue?.finish(); this.rpc?.close(); this.rpc = undefined; }
}
export class CodexNativeAdapter implements Adapter {
  readonly id = "codex-acp";
  readonly harnessName = AGENT_NAMES.codex;
  readonly models = ["GPT-5.5", "GPT-6 Astra"];
  isAvailable(): Promise<boolean> { return hasCommand(process.env.HABOR_CODEX_BIN ?? "codex"); }
  async createSession(opts: SessionOptions): Promise<Session> { return new CodexSession(opts); }
}
