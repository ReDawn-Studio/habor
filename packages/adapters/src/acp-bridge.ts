/**
 * ACP bridge for agents that do not expose ACP themselves.
 *
 * The bridge deliberately puts an ACP boundary in front of the legacy
 * adapter.  The router only talks to `ClientContext`/`ActiveSession`; the
 * legacy process is an implementation detail behind `session/new`,
 * `session/prompt`, `session/update`, `session/cancel` and `session/close`.
 *
 * This is also useful for vendors that ship a CLI today and an ACP server
 * later: the router contract does not change when the implementation moves
 * from this bridge to the vendor's native ACP server.
 */
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import {
  type Adapter,
  type AgentEvent,
  type PermissionDecision,
  type PermissionRequest,
  type Session,
  type SessionOptions,
  type ReasoningCapabilities
} from "@agent-router/core";

type LegacyAdapter = Adapter;

function textFromPrompt(prompt: any): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
}

function configOptions(reasoning: ReasoningCapabilities | undefined): any[] {
  if (!reasoning?.levels?.length) return [];
  return [{
    id: "reasoning_effort",
    name: "思考强度",
    category: "thought_level",
    type: "select",
    currentValue: reasoning.defaultId ?? "default",
    options: [
      { value: "default", name: "原生默认" },
      ...reasoning.levels.map(level => ({ value: level.id, name: level.label }))
    ]
  }];
}

function usageSize(usage: AgentEvent["usage"]): number {
  return usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
}

function updateFor(event: AgentEvent): any | undefined {
  if (event.type === "message") {
    const text = event.delta ?? event.text;
    if (!text) return;
    return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
  }
  if (event.type === "thinking") {
    if (!event.thinking) return;
    return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.thinking } };
  }
  if (event.type === "tool_call" && event.tool) {
    return {
      sessionUpdate: "tool_call",
      toolCallId: event.tool.id,
      title: event.tool.name,
      kind: "other",
      status: "pending",
      rawInput: event.tool.input ?? {}
    };
  }
  if (event.type === "tool_result" && event.toolResult) {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolResult.id,
      status: event.toolResult.isError ? "failed" : "completed",
      content: [{ type: "content", content: { type: "text", text: event.toolResult.output ?? "" } }]
    };
  }
  if (event.type === "file_change" && event.file) {
    return {
      sessionUpdate: "tool_call",
      toolCallId: `file-${randomUUID().slice(0, 8)}`,
      title: `${event.file.type}: ${event.file.path}`,
      kind: "edit",
      status: "completed",
      rawInput: event.file
    };
  }
  if (event.type === "terminal" && event.terminal) {
    return {
      sessionUpdate: "tool_call",
      toolCallId: `terminal-${randomUUID().slice(0, 8)}`,
      title: event.terminal.command ?? "Terminal",
      kind: "execute",
      status: "completed",
      rawInput: event.terminal
    };
  }
  if (event.type === "usage" && event.usage) {
    const used = usageSize(event.usage);
    if (used > 0) return { sessionUpdate: "usage_update", used, size: used };
  }
  return undefined;
}

/** Wrap a legacy Adapter behind an in-process ACP client/server connection. */
export function createAcpBridgeAdapter(legacy: LegacyAdapter): Adapter {
  return {
    id: legacy.id,
    harnessName: `${legacy.harnessName} · ACP bridge`,
    models: legacy.models,
    protocol: "acp",
    isAvailable: () => legacy.isAvailable(),
    createSession: async (opts: SessionOptions) => {
      const session = await legacy.createSession(opts);
      return new BridgedSession(legacy.id, opts, session);
    }
  };
}

class BridgedSession implements Session {
  readonly id: string;
  readonly adapterId: string;
  private connection?: acp.ClientConnection;
  private active?: acp.ActiveSession;
  private legacy: Session;
  private connectPromise?: Promise<void>;
  private latestReasoning?: ReasoningCapabilities;
  private promptError?: unknown;

  constructor(adapterId: string, readonly opts: SessionOptions, legacy: Session) {
    this.adapterId = adapterId;
    this.id = `${adapterId}-${randomUUID().slice(0, 8)}`;
    this.legacy = legacy;
  }

  get model(): string { return this.opts.model; }
  get cwd(): string { return this.opts.cwd; }

  private async ensureConnected(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    try { await this.connectPromise; }
    catch (error) { this.connectPromise = undefined; throw error; }
  }

  private async connect(): Promise<void> {
    const session = this.legacy;
    const sessionId = `bridge-${randomUUID().slice(0, 8)}`;
    let running = false;
    let cancelled = false;
    let promptPromise: Promise<unknown> | undefined;
    let lastError: string | undefined;
    let agentContext: acp.AgentContext | undefined;

    const agent = acp.agent({ name: `habor-${this.adapterId}-acp-bridge` })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false }
      }))
      .onRequest(acp.methods.agent.session.new, async ctx => {
        if (ctx.params.cwd !== this.cwd) throw new Error("ACP session cwd 与任务工作区不一致");
        return {
          sessionId,
          // Do not probe a legacy CLI during session/new. Some native
          // clients expose model capabilities through a separate RPC that
          // may be unavailable until the first turn; F4 asks for it lazily.
          configOptions: configOptions(this.latestReasoning),
          _meta: { haborAdapterId: this.adapterId, haborTransport: "acp-bridge" }
        } as any;
      })
      .onRequest(acp.methods.agent.session.setConfigOption, async ctx => {
        if (ctx.params.sessionId !== sessionId) throw new Error("ACP session not found");
        if (ctx.params.configId !== "reasoning_effort") throw new Error(`未知配置项: ${ctx.params.configId}`);
        const value = ctx.params.value === "default" ? undefined : String(ctx.params.value);
        await session.setReasoningEffort?.(value);
        return { configOptions: configOptions(this.latestReasoning) } as any;
      })
      .onRequest(acp.methods.agent.session.prompt, async ctx => {
        if (ctx.params.sessionId !== sessionId) throw new Error("ACP session not found");
        if (running) throw new Error("ACP prompt already running");
        running = true;
        cancelled = false;
        lastError = undefined;
        const input = textFromPrompt(ctx.params.prompt);
        promptPromise = (async () => {
          for await (const event of session.prompt(input)) {
            if (cancelled) break;
            if (event.type === "error") {
              // Preserve the legacy structured error through the ACP prompt
              // response. Throwing here would make the SDK replace it with a
              // generic JSON-RPC "Internal error".
              lastError = event.error?.message ?? "Agent error";
              continue;
            }
            const update = updateFor(event);
            if (update) await ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
          }
        })();
        try {
          await promptPromise;
          return { stopReason: cancelled ? "cancelled" : "end_turn", ...(lastError ? { _meta: { haborError: lastError } } : {}) } as any;
        } finally {
          running = false;
          promptPromise = undefined;
        }
      })
      .onNotification(acp.methods.agent.session.cancel, async ctx => {
        if (ctx.params.sessionId !== sessionId) return;
        cancelled = true;
        await session.cancel();
        await promptPromise?.catch(() => undefined);
      })
      .onRequest(acp.methods.agent.session.close, async ctx => {
        // The outer Session.close() owns the legacy resource.  Keeping this
        // ACP handler idempotent avoids closing the same native process twice
        // when a client sends session/close and then tears down its channel.
        return {};
      });

    const client = acp.client({ name: "habor" })
      .onNotification(acp.methods.client.session.update, () => {})
      .onRequest(acp.methods.client.session.requestPermission, async ctx => {
        const request: PermissionRequest = {
          id: ctx.params.toolCall.toolCallId,
          toolName: String(ctx.params.toolCall.title ?? "tool"),
          description: String(ctx.params.toolCall.title ?? "tool"),
          options: ctx.params.options.map(option => ({ id: option.optionId, name: option.name }))
        };
        const decision: PermissionDecision = this.opts.onPermission
          ? await this.opts.onPermission(request)
          : this.opts.permission === "auto"
            ? { allow: true, optionId: ctx.params.options[0]?.optionId }
            : { allow: false, message: "未提供权限回调" };
        return decision.allow
          ? { outcome: { outcome: "selected", optionId: decision.optionId ?? ctx.params.options[0]?.optionId } }
          : { outcome: { outcome: "denied" } } as any;
      });

    // The SDK's in-process composition still uses the exact ACP lifecycle and
    // schemas, so tests and the router exercise the same boundary as a stdio
    // ACP server without spawning an extra node process for every turn.
    this.connection = client.connect(agent);
    agentContext = this.connection.agent ? undefined : undefined;
    this.active = await this.connection.agent.buildSession(this.cwd).start();
    if (this.opts.reasoningEffort !== undefined) {
      await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.active.sessionId,
        configId: "reasoning_effort",
        value: this.opts.reasoningEffort
      } as any);
    }
  }

  async getReasoningCapabilities(): Promise<ReasoningCapabilities> {
    await this.ensureConnected();
    if (!this.latestReasoning && this.legacy.getReasoningCapabilities) {
      this.latestReasoning = await this.legacy.getReasoningCapabilities();
    }
    return this.latestReasoning ?? { source: "unknown", levels: [] };
  }

  async setReasoningEffort(effort: string | undefined): Promise<void> {
    await this.ensureConnected();
    if (!this.active || !this.connection) throw new Error("ACP session 不可用");
    await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.active.sessionId,
      configId: "reasoning_effort",
      value: effort ?? "default"
    } as any);
    this.opts.reasoningEffort = effort;
  }

  async *prompt(input: string): AsyncIterable<AgentEvent> {
    try {
      await this.ensureConnected();
      const active = this.active!;
      const request = active.prompt(input);
      request.catch(error => { this.promptError = error; });
      for (;;) {
        const message = await active.nextUpdate();
        if (message.kind === "stop") {
          const error = (message.response as any)?._meta?.haborError;
          if (error) yield { type: "error", error: { message: String(error) }, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
          break;
        }
        const update: any = message.update;
        const content = update?.content;
        if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text") {
          yield { type: "message", delta: content.text, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
        } else if (update?.sessionUpdate === "agent_thought_chunk" && content?.type === "text") {
          yield { type: "thinking", thinking: content.text, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
        } else if (update?.sessionUpdate === "tool_call") {
          yield { type: "tool_call", tool: { id: update.toolCallId, name: update.title, input: update.rawInput }, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
        } else if (update?.sessionUpdate === "tool_call_update") {
          const block = update.content?.[0]?.content;
          yield { type: "tool_result", toolResult: { id: update.toolCallId, name: "tool", output: block?.text ?? "", isError: update.status === "failed" }, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
        } else if (update?.sessionUpdate === "usage_update") {
          yield { type: "usage", usage: { totalTokens: update.used }, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
        }
      }
      await request.catch(() => undefined);
      if (this.promptError) {
        const error = this.promptError;
        this.promptError = undefined;
        yield { type: "error", error: { message: error instanceof Error ? error.message : String(error) }, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
      }
    } catch (error) {
      yield { type: "error", error: { message: error instanceof Error ? error.message : String(error) }, ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
    }
    yield { type: "done", ts: Date.now(), sessionId: this.id, adapterId: this.adapterId, model: this.model };
  }

  async cancel(): Promise<void> {
    if (this.connection && this.active) {
      await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.active.sessionId });
    } else await this.legacy.cancel();
  }

  async close(): Promise<void> {
    try {
      if (this.connection && this.active) {
        await this.connection.agent.request(acp.methods.agent.session.close, { sessionId: this.active.sessionId });
      }
    } finally {
      await this.legacy.close();
      this.active?.dispose();
      this.connection?.close();
      this.active = undefined;
      this.connection = undefined;
      this.connectPromise = undefined;
    }
  }
}
