import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets, toDisplayText, configuredReasoning, assertReasoningLevel, type ReasoningCapabilities, type Adapter, type AgentEvent, type Session, type SessionOptions } from "@agent-router/core";
import { hasCommand } from "./base.js";
import { EventQueue } from "./rpc.js";

export function claudeLaunch(opts: SessionOptions, sessionId: string, resume: boolean, resetEffort = false): { argv: string[]; env: NodeJS.ProcessEnv; settings?: { env: Record<string, string> } } {
  const modelId = opts.modelId ?? opts.model;
  const argv = ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", "--model", modelId, resume ? "--resume" : "--session-id", sessionId];
  argv.push("--permission-mode", opts.permission === "auto" ? "auto" : "dontAsk");
  const env = { ...process.env };
  let settings: { env: Record<string, string> } | undefined;
  if (opts.connection) {
    if (opts.connection.protocol !== "anthropic") throw new Error("Claude Code 需要 Anthropic Messages API");
    const overridden = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_CUSTOM_HEADERS"];
    for (const key of overridden) env[key] = "";
    env.ANTHROPIC_BASE_URL = opts.connection.baseUrl.replace(/\/v1\/?$/, "");
    env.ANTHROPIC_API_KEY = opts.connection.apiKey;
    env.ANTHROPIC_MODEL = modelId;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = modelId;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
    env.ANTHROPIC_SMALL_FAST_MODEL = modelId;
    env.CLAUDE_CODE_SUBAGENT_MODEL = modelId;
    // A user's settings.env can override inherited shell variables. The explicit
    // per-invocation settings layer binds this source above user/project settings.
    const names = [...overridden, "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_MODEL_OPTION", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
    settings = { env: Object.fromEntries(names.map(name => [name, env[name] ?? ""])) };
  }
  if (opts.reasoningEffort !== undefined || resetEffort) {
    assertReasoningLevel(configuredReasoning(opts, "claude-acp"), opts.reasoningEffort);
    const effort = opts.reasoningEffort ?? "auto";
    if (opts.reasoningEffort !== undefined) argv.push("--effort", opts.reasoningEffort);
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    settings ??= { env: {} };
    settings.env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  }
  return { argv, env, settings };
}
class ClaudeSession implements Session {
  readonly id = `claude-${randomUUID()}`;
  readonly adapterId = "claude-acp";
  private nativeId = randomUUID();
  private resume = false;
  private child?: ChildProcessWithoutNullStreams;
  private settingsDir?: string;
  private resetEffort = false;
  constructor(private opts: SessionOptions) {}
  get model(): string { return this.opts.model; }
  get cwd(): string { return this.opts.cwd; }
  async getReasoningCapabilities(): Promise<ReasoningCapabilities> { return configuredReasoning(this.opts, this.adapterId); }
  async setReasoningEffort(effort: string | undefined): Promise<void> {
    assertReasoningLevel(await this.getReasoningCapabilities(), effort);
    this.opts.reasoningEffort = effort; this.resetEffort = effort === undefined;
  }
  async *prompt(input: string): AsyncIterable<AgentEvent> {
    const queue = new EventQueue<AgentEvent>();
    const safe = (value: unknown) => redactSecrets(toDisplayText(value), [this.opts.connection?.apiKey ?? ""]);
    const emit = (event: Omit<AgentEvent, "ts" | "model" | "adapterId" | "sessionId">) => queue.push({ ...event, ts: Date.now(), model: this.model, adapterId: this.adapterId, sessionId: this.id });
    const launch = claudeLaunch(this.opts, this.nativeId, this.resume, this.resetEffort);
    if (launch.settings) {
      this.settingsDir ??= mkdtempSync(join(tmpdir(), "habor-claude-"));
      const path = join(this.settingsDir, "settings.json");
      writeFileSync(path, JSON.stringify(launch.settings), { mode: 0o600 });
      launch.argv.push("--settings", path);
    }
    const child = spawn(process.env.HABOR_CLAUDE_BIN ?? "claude", launch.argv, { cwd: this.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let stderr = "", streamedMessage = false, failed = false;
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-4000); });
    createInterface({ input: child.stdout }).on("line", line => {
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "system" && event.subtype === "init") {
        this.nativeId = event.session_id ?? this.nativeId; this.resume = true;
      } else if (event.type === "stream_event") {
        const chunk = event.event;
        if (chunk?.type === "message_start") streamedMessage = false;
        if (chunk?.delta?.type === "text_delta") { streamedMessage = true; emit({ type: "message", delta: toDisplayText(chunk.delta.text) }); }
        if (chunk?.delta?.type === "thinking_delta") emit({ type: "thinking", thinking: toDisplayText(chunk.delta.thinking) });
      } else if (event.type === "assistant" || event.type === "user") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && event.type === "assistant" && !streamedMessage) emit({ type: "message", delta: toDisplayText(block.text) });
          else if (block.type === "tool_use") emit({ type: "tool_call", tool: { id: block.id, name: block.name, input: block.input } });
          else if (block.type === "tool_result") emit({ type: "tool_result", toolResult: { id: block.tool_use_id, name: "tool", output: toDisplayText(block.content), isError: !!block.is_error } });
        }
      } else if (event.type === "result") {
        if (event.is_error || event.subtype !== "success") { failed = true; emit({ type: "error", error: { message: safe(event.errors ?? event.result ?? event.subtype) } }); }
        if (event.usage) emit({ type: "usage", usage: { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens, cachedTokens: event.usage.cache_read_input_tokens } });
      }
    });
    const fail = (error: unknown) => { if (!failed) emit({ type: "error", error: { message: safe(error) } }); failed = true; queue.finish(); };
    child.on("error", fail); child.stdin.on("error", fail);
    child.on("close", code => { if (code && !failed) fail(stderr || `Claude Code 已退出 (${code})`); queue.finish(); });
    child.stdin.end(input);
    try { for await (const event of queue) yield event; }
    finally { if (child.exitCode === null) child.kill("SIGTERM"); }
    yield { type: "done", ts: Date.now(), model: this.model, adapterId: this.adapterId, sessionId: this.id };
  }
  async cancel(): Promise<void> { this.child?.kill("SIGTERM"); }
  async close(): Promise<void> {
    const child = this.child; child?.kill("SIGTERM");
    if (child) setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000).unref();
    if (this.settingsDir) { rmSync(this.settingsDir, { recursive: true, force: true }); this.settingsDir = undefined; }
  }
}
export class ClaudeNativeAdapter implements Adapter {
  readonly id = "claude-acp";
  readonly harnessName = "Claude Code";
  readonly models = ["Claude Sonnet 4.6", "Claude Fable 5"];
  isAvailable(): Promise<boolean> { return hasCommand(process.env.HABOR_CLAUDE_BIN ?? "claude"); }
  async createSession(opts: SessionOptions): Promise<Session> { return new ClaudeSession(opts); }
}
