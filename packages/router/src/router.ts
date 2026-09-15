/**
 * core/router.ts — 带 Task/Session 亲和性的 Router（Orchestrator 的下层）。
 *
 * 亲和性规则（产品核心）：
 *   1. 「继续刚才的任务」→ 命中现有 SessionBinding，永远留在同一个
 *      (harness, session) 上执行，Router 不重新判路由。
 *   2. 只有显式切换（switchTaskModel）或新建任务才产生新绑定。
 *   3. 会话对象丢失（进程重启等）时，按绑定的 adapterId+model 重建，
 *      仍然不换 harness —— 亲和性是对「harness」的，不是对进程的。
 *
 * 会话绑定 → 实时 Session 对象 由本层持有（SessionRegistry）。
 */
import type { Adapter, AgentEvent, Session } from "@agent-router/core";
import { normalizeEventText, documentedReasoning, assertReasoningLevel, reasoningPreferenceKey, type ReasoningCapabilities } from "@agent-router/core";
import type { Registry } from "./registry.js";
import { TaskStore, type SessionBinding, type Task } from "./state.js";

export interface TaskRouterOptions {
  /** 会话绑定持久目录（可选；留空则不落盘） */
  stateFile?: string;
}

export class TaskRouter {
  private sessions = new Map<string, Session>();
  private activeTurns = new Map<string, AbortController>();
  private stateFile: string | undefined;

  constructor(
    private registry: Registry,
    private tasks: TaskStore,
    opts: TaskRouterOptions = {}
  ) {
    this.stateFile = opts.stateFile;
  }

  /** 模型可用性（委托给 Registry；CLI/IDE 用）。 */
  async isModelAvailable(model: string): Promise<boolean> {
    return this.registry.isModelAvailable(model);
  }

  /** 可用模型列表（委托给 Registry）。 */
  async listAvailableModels(): Promise<string[]> {
    return this.registry.listAvailableModels();
  }

  /** 当前任务列表（State 层查询）。 */
  listTasks(): Task[] {
    return this.tasks.listTasks();
  }

  getTask(id: string): Task | undefined {
    return this.tasks.getTask(id);
  }

  /** Reopen a persisted task without changing its latest model binding. */
  resumeTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    const latest = task.bindings.at(-1);
    if (!latest) throw new Error("该任务没有可恢复的模型绑定");
    for (const binding of task.bindings) if (binding !== latest) binding.endedAt ??= Date.now();
    latest.endedAt = undefined;
    task.status = "active";
    task.updatedAt = Date.now();
    return task;
  }

  /** 新建任务：Router 首次判路由（用户选模型 → 对应原生 harness）。 */
  async newTask(opts: { model: string; cwd: string; title?: string; permission?: "ask" | "auto"; reasoningEffort?: string }): Promise<Task> {
    const task = this.tasks.createTask({
      title: opts.title ?? `任务 @ ${new Date().toLocaleTimeString()}`,
      cwd: opts.cwd,
      meta: { model: opts.model, permission: opts.permission ?? "auto" }
    });
    await this.routeAndBind(task, { model: opts.model, reason: "new", permission: opts.permission, reasoningEffort: opts.reasoningEffort });
    return task;
  }

  /** 显式切换模型（同一任务继续，保留 conversation；切换前捕获快照）。 */
  async switchTaskModel(taskId: string, model: string, opts?: { permission?: "ask" | "auto"; reasoningEffort?: string }): Promise<Task> {
    const task = this.requireTask(taskId);
    const old = this.tasks.currentTarget(task);
    if (old && old.model === model) return task; // 同模型：无操作

    // 切换前捕获上下文快照（供新 harness 接续）
    const lastTurns = this.tasks.lastTurns(task, 10);
    this.tasks.captureSnapshot(task, {
      touchedFiles: this.collectTouchedFiles(task),
      summary: lastTurns
        .filter((t) => t.role === "assistant" && t.text)
        .map((t) => `[${t.model ?? t.adapterId}] ${t.text.slice(0, 200)}`)
        .join("\n")
        .slice(0, 2000)
    });

    // 关闭旧会话
    if (old) {
      const s = this.sessions.get(old.sessionId);
      if (s) {
        try {
          await s.close();
        } catch {
          /* 忽略关闭错误 */
        }
        this.sessions.delete(old.sessionId);
      }
    }

    const reasoningEffort = opts && Object.hasOwn(opts, "reasoningEffort") ? opts.reasoningEffort : this.savedEffort(task, model);
    await this.routeAndBind(task, { model, reason: "switch", permission: opts?.permission, reasoningEffort });
    return task;
  }

  /** 亲和性核心：继续任务。若任务已有绑定 → 必须走原 (harness, session)。 */
  async *continueTask(taskId: string, input: string): AsyncIterable<AgentEvent> {
    if (this.activeTurns.has(taskId)) throw new Error("当前任务正在回复，请等待完成或先停止回复");
    const controller = new AbortController();
    this.activeTurns.set(taskId, controller);
    try {
      yield* this.streamTask(taskId, input, controller.signal);
    } finally {
      this.activeTurns.delete(taskId);
    }
  }

  private async *streamTask(taskId: string, input: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const task = this.requireTask(taskId);
    const binding = this.tasks.activeBinding(task);
    if (!binding) {
      throw new Error(`任务 ${taskId} 没有活跃会话绑定，请先 /model 选择一个模型`);
    }
    const target = {
      sessionId: binding.sessionId,
      adapterId: binding.adapterId,
      model: binding.model
    };

    // 亲和性：重建也留在同一 harness（绑定里的 adapterId+model 不变）
    let session = this.sessions.get(target.sessionId);
    const restored = !session;
    if (!session) {
      session = await this.registry.createSession(target.model, {
        cwd: task.cwd,
        permission: (task.meta.permission as "ask" | "auto") ?? "auto",
        reasoningEffort: this.savedEffort(task, target.model)
      });
      // 新 session id，但绑定指向原 adapterId —— harness 不变
      this.sessions.set(target.sessionId, session);
    }
    if (signal.aborted) {
      this.sessions.delete(target.sessionId);
      await session.close();
      return;
    }

    // —— 任务简报：switch 绑定首次执行时，把前情上下文注入给新 harness ——
    // 理念：切换只是换物理载体，任务本身（对话历史/触碰文件/快照）必须延续
    let effectiveInput = input;
    if (restored || (binding.reason === "switch" && !binding.briefed)) {
      binding.briefed = true;
      effectiveInput = `${this.buildTaskBriefing(task)}\n\n${input}`;
    }

    this.tasks.appendTurn(task, { role: "user", text: input, model: target.model, adapterId: target.adapterId });

    const iterator = session.prompt(effectiveInput)[Symbol.asyncIterator]();
    let cancel: () => void = () => {};
    const interrupted = new Promise<IteratorResult<AgentEvent>>((resolve) => {
      cancel = () => resolve({ done: true, value: undefined });
      signal.addEventListener("abort", cancel, { once: true });
    });
    let answer = "";
    try {
      while (!signal.aborted) {
        const next = await Promise.race([iterator.next(), interrupted]);
        if (next.done || signal.aborted) break;
        const ev = normalizeEventText(next.value);
        if (ev.type === "message") {
          if (ev.delta !== undefined) answer += ev.delta;
          else if (ev.text) answer = ev.text.startsWith(answer) ? ev.text : answer + ev.text;
        }
        yield ev;
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      // Some transports leave nextUpdate pending after their process dies.
      // Releasing the UI must not wait on that transport's iterator.return().
      void iterator.return?.().catch(() => {});
      if (answer) {
        this.tasks.appendTurn(task, {
          role: "assistant",
          text: answer,
          model: target.model,
          adapterId: target.adapterId
        });
      }
    }
  }

  /** Stop this turn and discard the killed transport. The next turn restores its task context. */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    const controller = this.activeTurns.get(taskId);
    if (!controller) return;
    const target = this.tasks.currentTarget(task);
    const session = target ? this.sessions.get(target.sessionId) : undefined;
    if (target) this.sessions.delete(target.sessionId);
    controller.abort();
    if (session) {
      try { await session.cancel(); }
      finally { await session.close(); }
    }
  }

  async close(): Promise<void> {
    for (const controller of this.activeTurns.values()) controller.abort();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async session => {
      try { await session.cancel(); }
      finally { await session.close(); }
    }));
  }

  async refreshSession(taskId: string): Promise<void> {
    if (this.activeTurns.has(taskId)) throw new Error("当前任务正在执行，结束后再更新连接");
    const target = this.tasks.currentTarget(this.requireTask(taskId));
    if (!target) return;
    const session = this.sessions.get(target.sessionId);
    this.sessions.delete(target.sessionId);
    await session?.close();
  }

  private effortKey(model: string): string {
    const entry = this.registry.entry(model);
    if (!entry) throw new Error(`未知模型: ${model}`);
    return reasoningPreferenceKey(entry);
  }
  private savedEffort(task: Task, model: string): string | undefined {
    return (task.meta.reasoningEfforts as Record<string, string> | undefined)?.[this.effortKey(model)];
  }
  private rememberEffort(task: Task, model: string, effort?: string): void {
    const values = { ...(task.meta.reasoningEfforts as Record<string, string> | undefined) };
    const key = this.effortKey(model);
    if (effort === undefined) delete values[key]; else values[key] = effort;
    task.meta.reasoningEfforts = values;
  }
  getReasoningEffort(taskId: string): string | undefined {
    const task = this.requireTask(taskId), target = this.tasks.currentTarget(task);
    return target ? this.savedEffort(task, target.model) : undefined;
  }
  async reasoningCapabilities(taskId: string): Promise<ReasoningCapabilities> {
    const task = this.requireTask(taskId), target = this.tasks.currentTarget(task);
    if (!target) throw new Error("请先选择模型");
    let session = this.sessions.get(target.sessionId);
    if (!session) {
      session = await this.registry.createSession(target.model, { cwd: task.cwd, permission: task.meta.permission as "ask" | "auto", reasoningEffort: this.savedEffort(task, target.model) });
      this.sessions.set(target.sessionId, session);
    }
    const entry = this.registry.entry(target.model)!;
    return session.getReasoningCapabilities ? session.getReasoningCapabilities() : documentedReasoning(entry.adapterId, entry.modelId ?? entry.model);
  }
  async setReasoningEffort(taskId: string, effort?: string): Promise<void> {
    if (this.activeTurns.has(taskId)) throw new Error("请在当前回复结束后调整思考强度");
    const task = this.requireTask(taskId), target = this.tasks.currentTarget(task);
    if (!target) throw new Error("请先选择模型");
    const capabilities = await this.reasoningCapabilities(taskId);
    assertReasoningLevel(capabilities, effort);
    const session = this.sessions.get(target.sessionId);
    if (session?.setReasoningEffort) await session.setReasoningEffort(effort);
    else await this.refreshSession(taskId);
    this.rememberEffort(task, target.model, effort);
  }

  /** 生成任务简报：前情对话 + 触碰文件 + 最后一次快照摘要（switch 时注入给新模型）。 */
  private buildTaskBriefing(task: Task): string {
    const parts: string[] = [];
    parts.push(`【任务简报 · 由 habor 注入】\n任务: ${task.title}`);
    const previous = task.bindings.filter((b) => b.endedAt !== undefined).at(-1);
    if (previous) {
      parts.push(`此前由 ${previous.model}（${previous.adapterId}）执行。`);
    }
    const turns = this.tasks.lastTurns(task, 40);
    const history = turns
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => `[${t.model ?? t.adapterId} · ${t.role === "user" ? "用户" : "助手"}] ${t.text}`)
      .join("\n");
    if (history) parts.push(`对话记录:\n${history}`);
    const snap = task.contextSnapshots.at(-1);
    if (snap?.summary) parts.push(`切换前上下文摘要:\n${snap.summary}`);
    const files = new Set<string>();
    for (const s of task.contextSnapshots) for (const f of s.touchedFiles) files.add(f);
    if (files.size > 0) parts.push(`已触碰文件: ${[...files].join(", ")}`);
    parts.push("请基于以上上下文继续当前任务，不要重复已完成的工作。");
    return parts.join("\n\n");
  }

  /** 任务当前绑定信息（CLI /status 用）。 */
  status(taskId: string): { task: Task; target?: { sessionId: string; adapterId: string; model: string } } {
    const task = this.requireTask(taskId);
    return { task, target: this.tasks.currentTarget(task) };
  }

  async finishTask(taskId: string, status: "done" | "failed"): Promise<void> {
    const task = this.requireTask(taskId);
    this.tasks.finishTask(task, status);
    const target = this.tasks.currentTarget(task);
    if (target) {
      const s = this.sessions.get(target.sessionId);
      if (s) await s.close();
      this.sessions.delete(target.sessionId);
      for (const b of task.bindings) if (b.endedAt === undefined) b.endedAt = Date.now();
    }
  }

  // —— 内部 ——

  private requireTask(taskId: string): Task {
    const task = this.tasks.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    return task;
  }

  private async routeAndBind(
    task: Task,
    opts: { model: string; reason: "new" | "switch"; permission?: "ask" | "auto"; reasoningEffort?: string }
  ): Promise<SessionBinding> {
    const session = await this.registry.createSession(opts.model, {
      cwd: task.cwd,
      permission: opts.permission ?? ((task.meta.permission as "ask" | "auto") ?? "auto"),
      reasoningEffort: opts.reasoningEffort
    });
    this.sessions.set(session.id, session);
    task.meta.permission = opts.permission ?? task.meta.permission;
    this.rememberEffort(task, opts.model, opts.reasoningEffort);
    return this.tasks.bindSession(task, {
      sessionId: session.id,
      adapterId: session.adapterId,
      model: opts.model,
      reason: opts.reason
    });
  }

  private collectTouchedFiles(task: Task): string[] {
    const files = new Set<string>();
    for (const t of task.conversation) {
      if (t.role === "tool" && t.text) {
        const m = t.text.match(/(?:path|file)["']?\s*[:=]\s*["']([^"']+)["']/g);
        m?.forEach((x) => {
          const p = x.split(/[:=]/)[1]?.trim().replace(/["']/g, "");
          if (p) files.add(p);
        });
      }
    }
    return [...files];
  }
}

export type { Task, SessionBinding };
