/**
 * core/state.ts — State 层（项目的核心差异化）。
 *
 * 统一管理跨 harness 的任务级状态：
 *   Task        —— 任务的持久单位，跨 agent 切换保持不变
 *   SessionBinding —— 任务 ↔ (harness session) 的绑定链，记录每次切换
 *   Conversation —— 跨 harness 的统一对话记录
 *   ContextSnapshot —— 切换时的上下文快照（可恢复的引用）
 *   Artifact    —— 产物（diff / 文件 / 日志）
 *   Checkpoint  —— 可回滚点（git ref / 快照引用）
 *   Workspace   —— 任务工作区（cwd + 状态目录）
 *
 * 核心不变量（亲和性）：
 *   「继续刚才的任务」必须命中同一个 session 绑定，Router 不得重新判路由；
 *   只有用户显式切换模型/新建任务才产生新绑定。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** 一次会话绑定：任务在某段时间内跑在哪个 harness session 上。 */
export interface SessionBinding {
  sessionId: string;
  adapterId: string;
  /** 用户可见模型 */
  model: string;
  startedAt: number;
  endedAt?: number;
  reason: "new" | "switch";
  /** switch 绑定是否已注入过任务简报（前情上下文） */
  briefed?: boolean;
}

/** 统一对话记录（跨 harness 追加，不随切换丢失）。 */
export interface ConversationTurn {
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** 由哪个模型产生 */
  model?: string;
  /** 由哪个 harness 产生 */
  adapterId?: string;
  ts: number;
}

/** 上下文快照：切换 harness 时捕获，供新 harness 接续上下文。 */
export interface ContextSnapshot {
  id: string;
  taskId: string;
  /** 对应第几个 binding（0-based） */
  bindingIndex: number;
  capturedAt: number;
  /** 截至该时刻的对话轮数 */
  conversationTurns: number;
  /** 任务触碰过的文件（相对 cwd） */
  touchedFiles: string[];
  /** 摘要（人工或 LLM 生成，v1 由调用方传入） */
  summary?: string;
}

/** 产物。 */
export interface Artifact {
  id: string;
  kind: "diff" | "file" | "log";
  /** 相对工作区的路径 */
  path: string;
  createdAt: number;
  size: number;
}

/** 可回滚点。 */
export interface Checkpoint {
  id: string;
  taskId: string;
  createdAt: number;
  /** git commit / stash 引用 */
  gitRef?: string;
  contextSnapshotId?: string;
  note: string;
}

/** 任务状态。 */
export type TaskStatus = "active" | "done" | "failed";

/** 任务：跨 harness 切换保持不变的持久单位。 */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** 会话绑定链（按时间顺序） */
  bindings: SessionBinding[];
  /** 统一对话记录 */
  conversation: ConversationTurn[];
  /** 上下文快照 */
  contextSnapshots: ContextSnapshot[];
  artifacts: Artifact[];
  checkpoints: Checkpoint[];
  /** 附加元数据 */
  meta: Record<string, unknown>;
}

export interface CreateTaskOptions {
  title: string;
  cwd: string;
  meta?: Record<string, unknown>;
}

/**
 * TaskStore：State 层的存储与查询。
 * v1 内存实现；持久化由 save/load 完成（JSONL）。
 */
export class TaskStore {
  private tasks = new Map<string, Task>();
  private seq = 0;

  createTask(opts: CreateTaskOptions): Task {
    const task: Task = {
      id: `task-${randomUUID().slice(0, 12)}`,
      title: opts.title,
      status: "active",
      cwd: opts.cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bindings: [],
      conversation: [],
      contextSnapshots: [],
      artifacts: [],
      checkpoints: [],
      meta: opts.meta ?? {}
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private touch(task: Task): void {
    task.updatedAt = Date.now();
  }

  /** 当前活跃绑定（最近一个未结束的）。 */
  activeBinding(task: Task): SessionBinding | undefined {
    return [...task.bindings].reverse().find((b) => b.endedAt === undefined);
  }

  /** 亲和性核心：任务当前绑定在哪个 (harness, session) 上。 */
  currentTarget(task: Task): { sessionId: string; adapterId: string; model: string } | undefined {
    const b = this.activeBinding(task);
    if (!b) return undefined;
    return { sessionId: b.sessionId, adapterId: b.adapterId, model: b.model };
  }

  /** 绑定新 session（新任务或显式切换）。reason = new | switch。 */
  bindSession(
    task: Task,
    opts: { sessionId: string; adapterId: string; model: string; reason: "new" | "switch" }
  ): SessionBinding {
    // 结束旧绑定
    for (const b of task.bindings) {
      if (b.endedAt === undefined) b.endedAt = Date.now();
    }
    const binding: SessionBinding = {
      sessionId: opts.sessionId,
      adapterId: opts.adapterId,
      model: opts.model,
      startedAt: Date.now(),
      reason: opts.reason
    };
    task.bindings.push(binding);
    this.touch(task);
    return binding;
  }

  appendTurn(task: Task, turn: Omit<ConversationTurn, "seq" | "ts">): ConversationTurn {
    const t: ConversationTurn = { ...turn, seq: ++this.seq, ts: Date.now() };
    task.conversation.push(t);
    this.touch(task);
    return t;
  }

  lastTurns(task: Task, n = 20): ConversationTurn[] {
    return task.conversation.slice(-n);
  }

  captureSnapshot(
    task: Task,
    opts: { touchedFiles: string[]; summary?: string }
  ): ContextSnapshot {
    const bindingIndex = task.bindings.length - 1;
    const snap: ContextSnapshot = {
      id: `snap-${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      bindingIndex: Math.max(0, bindingIndex),
      capturedAt: Date.now(),
      conversationTurns: task.conversation.length,
      touchedFiles: opts.touchedFiles,
      summary: opts.summary
    };
    task.contextSnapshots.push(snap);
    this.touch(task);
    return snap;
  }

  addArtifact(task: Task, artifact: Omit<Artifact, "id" | "createdAt">): Artifact {
    const a: Artifact = { ...artifact, id: `art-${randomUUID().slice(0, 8)}`, createdAt: Date.now() };
    task.artifacts.push(a);
    this.touch(task);
    return a;
  }

  addCheckpoint(task: Task, opts: { note: string; gitRef?: string; contextSnapshotId?: string }): Checkpoint {
    const c: Checkpoint = {
      id: `cp-${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      createdAt: Date.now(),
      gitRef: opts.gitRef,
      contextSnapshotId: opts.contextSnapshotId,
      note: opts.note
    };
    task.checkpoints.push(c);
    this.touch(task);
    return c;
  }

  finishTask(task: Task, status: "done" | "failed"): void {
    task.status = status;
    this.touch(task);
  }

  // —— 序列化（JSONL 持久化）——

  toJSON(): string {
    return [...this.tasks.values()].map((t) => JSON.stringify(t)).join("\n");
  }

  loadFromJSON(json: string): void {
    this.tasks.clear();
    this.seq = 0;
    for (const line of json.split("\n")) {
      if (!line.trim()) continue;
      const t = JSON.parse(line) as Task;
      this.tasks.set(t.id, t);
      for (const turn of t.conversation) {
        if (turn.seq > this.seq) this.seq = turn.seq;
      }
    }
  }

  /** 任务状态目录（workspace 下的 .habor/）。 */
  static stateDir(cwd: string): string {
    return join(cwd, ".habor");
  }
}
