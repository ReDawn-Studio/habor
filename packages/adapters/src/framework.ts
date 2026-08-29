/**
 * adapters/framework.ts — 通用「子进程 agent 框架」。
 *
 * 核心目标：以后每接入一个新的原生 harness，只写一个声明式 spec
 * （命令 + 参数 + 行解析器），spawn / 流式 / cancel / 超时 / 事件归一化
 * 全部由本框架复用，不再重复写整个 adapter。
 *
 * 两个执行形态：
 *   - collectText（一次性）：stdout 全量收集 → 最终 message（dsh/zcode）
 *   - parseLine（流式）：逐行 JSON 解析 → 事件流（kimi/claude/codex）
 */
import { randomUUID } from "node:crypto";
import type { Adapter, AgentEvent, Session, SessionOptions } from "@agent-router/core";
import { hasCommand, runCli, runCliLines } from "./base.js";

/** 一次执行的上下文（每轮 prompt 生成）。 */
export interface CliRunContext {
  model: string;
  cwd: string;
  permission: "ask" | "auto";
  prompt: string;
  sessionId: string;
}

/** 事件发射器：框架已注入 ts/sessionId/adapterId/model，spec 只需给 type + 载荷。 */
export type Emit = (ev: Omit<AgentEvent, "ts" | "sessionId" | "adapterId" | "model">) => void;

/** 进程结束后的兜底上下文。 */
export interface CliExitContext {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  /** 是否已产出过任何内容 */
  emitted: boolean;
}

/** 一个原生 harness 的声明式接入规格。 */
export interface CliAgentSpec {
  /** 内部 id：dsh / zcode / kimi / claude / codex ... */
  id: string;
  /** 内部 harness 名（用户不可见） */
  harnessName: string;
  /** 该 harness 可服务的用户可见模型名 */
  models: string[];
  /** 每轮构建执行命令 */
  buildCommand(ctx: CliRunContext): { cmd: string; argv: string[] };
  /** 流式形态：逐行解析 stdout → 事件（无跨行状态时用）。 */
  parseLine?(line: string, emit: Emit): void;
  /**
   * 会话级解析器工厂：需要跨行状态（如 textBuf/usageBuf）时用。
   * 优先于 parseLine。
   */
  createParser?(ctx: CliRunContext): { onLine(line: string, emit: Emit): void };
  /** 一次性形态：收集完整 stdout 作为最终 message。 */
  collectText?: boolean;
  /** 进程结束兜底：非 0 退出 / 超时 → error 事件。 */
  onExit?(ctx: CliExitContext, emit: Emit): void;
  /** 本机可用性检查（默认按命令是否存在）。 */
  isAvailable?(): Promise<boolean>;
  /** 超时（默认 20 分钟）。 */
  timeoutMs?: number;
  /** 额外环境变量。 */
  env?(): NodeJS.ProcessEnv;
}

/** 异步事件队列：parseLine 同步 push，prompt 迭代器异步消费。 */
function createEventQueue() {
  let queue: AgentEvent[] = [];
  let finished = false;
  let waiter: (() => void) | null = null;
  return {
    push(ev: AgentEvent) {
      queue.push(ev);
      const w = waiter;
      waiter = null;
      w?.();
    },
    finish() {
      finished = true;
      const w = waiter;
      waiter = null;
      w?.();
    },
    async *[Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent> {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (finished) {
          return;
        } else {
          await new Promise<void>((r) => (waiter = r));
        }
      }
    }
  };
}

/** 由 spec 构建一个标准 Adapter。 */
export function createCliAdapter(spec: CliAgentSpec): Adapter {
  const sample = spec.buildCommand({
    model: spec.models[0] ?? "",
    cwd: process.cwd(),
    permission: "auto",
    prompt: "",
    sessionId: ""
  });
  return {
    id: spec.id,
    harnessName: spec.harnessName,
    models: spec.models,
    isAvailable: async () => {
      if (spec.isAvailable) return spec.isAvailable();
      return hasCommand(sample.cmd);
    },
    createSession: async (opts: SessionOptions) => new CliAgentSession(spec, opts)
  };
}

class CliAgentSession implements Session {
  readonly id: string;
  readonly adapterId: string;
  private child: ReturnType<typeof runCliLines>["child"] | null = null;

  constructor(
    private spec: CliAgentSpec,
    readonly opts: SessionOptions
  ) {
    this.adapterId = spec.id;
    this.id = `${spec.id}-${randomUUID().slice(0, 8)}`;
  }

  get model(): string {
    return this.opts.model;
  }
  get cwd(): string {
    return this.opts.cwd;
  }

  async *prompt(input: string): AsyncIterable<AgentEvent> {
    const ctx: CliRunContext = {
      model: this.opts.model,
      cwd: this.opts.cwd,
      permission: this.opts.permission ?? "auto",
      prompt: input,
      sessionId: this.id
    };
    const { cmd, argv } = this.spec.buildCommand(ctx);
    const q = createEventQueue();
    const base = { sessionId: this.id, adapterId: this.spec.id, model: this.opts.model };
    const emit: Emit = (ev) => q.push({ ...ev, ...base, ts: Date.now() } as AgentEvent);

    const { child, lines, result } = runCliLines({
      cmd,
      argv,
      cwd: this.opts.cwd,
      env: this.spec.env?.() ?? {},
      timeoutMs: this.spec.timeoutMs ?? 20 * 60 * 1000
    });
    this.child = child;

    // 生产者：解析 stdout → push 事件；进程结束后兜底并 push done。
    const producer = (async () => {
      let textBuf = "";
      const parser = this.spec.createParser?.(ctx);
      try {
        if (this.spec.collectText) {
          for await (const line of lines) textBuf += line + "\n";
        } else if (parser) {
          for await (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            parser.onLine(t, emit);
          }
        } else if (this.spec.parseLine) {
          for await (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            this.spec.parseLine(t, emit);
          }
        } else {
          for await (const _ of lines) {
            /* 无解析器：丢弃 stdout */
          }
        }
      } finally {
        const r = await result;
        const exitCtx: CliExitContext = {
          exitCode: r.exitCode,
          stderr: r.stderr,
          timedOut: r.timedOut,
          emitted: false
        };
        if (this.spec.collectText && textBuf.trim()) emit({ type: "message", text: textBuf.trim() });
        this.spec.onExit?.(exitCtx, emit);
        q.finish();
      }
    })();

    try {
      let any = false;
      for await (const ev of q) {
        any = true;
        yield ev;
        if (ev.type === "done") break;
      }
    } finally {
      await producer.catch(() => undefined);
      this.child = null;
    }
  }

  cancel(): Promise<void> {
    if (this.child) this.child.kill("SIGKILL");
    return Promise.resolve();
  }
  close(): Promise<void> {
    return this.cancel();
  }
}
