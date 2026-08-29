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
import type { Registry } from "./registry.js";
import { TaskStore, type SessionBinding, type Task } from "./state.js";

export interface TaskRouterOptions {
  /** 会话绑定持久目录（可选；留空则不落盘） */
  stateFile?: string;
}

export class TaskRouter {
  private sessions = new Map<string, Session>();
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

  /** 新建任务：Router 首次判路由（用户选模型 → 对应原生 harness）。 */
  async newTask(opts: { model: string; cwd: string; title?: string; permission?: "ask" | "auto" }): Promise<Task> {
    const task = this.tasks.createTask({
      title: opts.title ?? `任务 @ ${new Date().toLocaleTimeString()}`,
      cwd: opts.cwd,
      meta: { model: opts.model, permission: opts.permission ?? "auto" }
    });
    await this.routeAndBind(task, { model: opts.model, reason: "new", permission: opts.permission });
    return task;
  }

  /** 显式切换模型（同一任务继续，保留 conversation；切换前捕获快照）。 */
  async switchTaskModel(taskId: string, model: string, opts?: { permission?: "ask" | "auto" }): Promise<Task> {
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

    await this.routeAndBind(task, { model, reason: "switch", permission: opts?.permission });
    return task;
  }

  /** 亲和性核心：继续任务。若任务已有绑定 → 必须走原 (harness, session)。 */
  async *continueTask(taskId: string, input: string): AsyncIterable<AgentEvent> {
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
    if (!session) {
      session = await this.registry.createSession(target.model, {
        cwd: task.cwd,
        permission: (task.meta.permission as "ask" | "auto") ?? "auto"
      });
      // 新 session id，但绑定指向原 adapterId —— harness 不变
      this.sessions.set(target.sessionId, session);
    }

    // —— 任务简报：switch 绑定首次执行时，把前情上下文注入给新 harness ——
    // 理念：切换只是换物理载体，任务本身（对话历史/触碰文件/快照）必须延续
    let effectiveInput = input;
    if (binding.reason === "switch" && !binding.briefed) {
      binding.briefed = true;
      effectiveInput = `${this.buildTaskBriefing(task)}\n\n${input}`;
    }

    this.tasks.appendTurn(task, { role: "user", text: input, model: target.model, adapterId: target.adapterId });

    for await (const ev of session.prompt(effectiveInput)) {
      if (ev.type === "message" && ev.text) {
        this.tasks.appendTurn(task, {
          role: "assistant",
          text: ev.text,
          model: target.model,
          adapterId: target.adapterId
        });
      }
      yield ev;
    }
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
    opts: { model: string; reason: "new" | "switch"; permission?: "ask" | "auto" }
  ): Promise<SessionBinding> {
    const session = await this.registry.createSession(opts.model, {
      cwd: task.cwd,
      permission: opts.permission ?? ((task.meta.permission as "ask" | "auto") ?? "auto")
    });
    this.sessions.set(session.id, session);
    task.meta.permission = opts.permission ?? task.meta.permission;
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
