/**
 * tui/index.ts — habor 全屏 TUI 控制器。
 *
 * 生命周期：start()（进入 alt screen + raw mode）→ 事件循环（动画 tick）
 * → stop()（恢复终端）。输入经 AppView 处理，提交后回调 CLI。
 */
import { Terminal } from "./vendor/term.js";
import { AppView, type Block } from "./app.js";
import type { ProviderProfile, ReasoningCapabilities } from "@agent-router/core";
import type { AuthMethod, AuthStatus } from "../agent-auth.js";

export interface TuiControllerOptions {
  version: string;
  cwd?: string;
  /** 提交一行输入（命令或 prompt） */
  onInput: (line: string) => void | Promise<void>;
  /** Tab 补全 */
  onComplete?: (line: string) => string[];
  onSelectModel?: (model: string) => void | Promise<void>;
  onSaveProvider?: (profile: ProviderProfile, key?: string, useModelId?: string) => Promise<void | string>;
  onOpenAgentDocs?: (model: string) => Promise<void>;
  onInstallAgent?: (model: string, onOutput: (line: string) => void, signal: AbortSignal) => Promise<string>;
  onLoginAgent?: (model: string, method: AuthMethod) => Promise<AuthStatus>;
  onInspectAgentAuth?: (model: string) => Promise<AuthStatus>;
  /** 工作区信任：选择模型前确认当前目录可信 */
  onCheckWorkspaceTrust?: () => Promise<boolean> | boolean;
  onTrustWorkspace?: () => Promise<void>;
  onWorkspaceTrustDenied?: () => void;
  onGetReasoning?: () => Promise<ReasoningCapabilities>;
  onSetReasoning?: (effort: string | undefined) => Promise<void>;
  /** Ctrl-C / Esc */
  onInterrupt?: () => void;
  onExit?: () => void;
}

export class TuiController {
  private term: Terminal;
  view: AppView;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private nativeActive = false;

  constructor(private opts: TuiControllerOptions) {
    this.term = new Terminal();
    this.view = new AppView({
      terminal: this.term,
      version: opts.version,
      cwd: opts.cwd,
      onInput: opts.onInput,
      onComplete: opts.onComplete,
      onSelectModel: opts.onSelectModel,
      onSaveProvider: opts.onSaveProvider,
      onOpenAgentDocs: opts.onOpenAgentDocs,
      onInstallAgent: opts.onInstallAgent,
      onLoginAgent: opts.onLoginAgent,
      onInspectAgentAuth: opts.onInspectAgentAuth,
      onCheckWorkspaceTrust: opts.onCheckWorkspaceTrust,
      onTrustWorkspace: opts.onTrustWorkspace,
      onWorkspaceTrustDenied: opts.onWorkspaceTrustDenied,
      onGetReasoning: opts.onGetReasoning,
      onSetReasoning: opts.onSetReasoning,
      onCancelInput: opts.onInterrupt,
      onExit: opts.onExit
    });
  }

  get isActive(): boolean {
    return this.term.raw;
  }

  start(): void {
    if (this.stopped) return;
    this.term.start();
    this.term.on("key", (key: any) => {
      this.view.handleKey(key);
    });
    this.term.on("resize", () => this.view.paint());
    // 动画帧（spinner / 运行状态）
    this.timer = setInterval(() => this.view.tick(), 100);
    this.view.paint();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.term.stop();
  }

  async withNativeTerminal<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped || this.nativeActive) throw new Error("终端正在由其他操作使用");
    this.nativeActive = true;
    if (this.timer) clearInterval(this.timer);
    this.term.stop();
    const keepParentAlive = () => {}; // Ctrl+C reaches the foreground native client; habor resumes when it exits.
    process.on("SIGINT", keepParentAlive);
    try { return await action(); }
    finally {
      process.off("SIGINT", keepParentAlive); this.nativeActive = false;
      if (!this.stopped) {
        this.term.start(); this.view.paint();
        this.timer = setInterval(() => this.view.tick(), 100);
      }
    }
  }

  // —— 数据接口（CLI 调用） ——

  setModel(model: string | null): void {
    this.view.setModel(model);
  }
  setTask(taskId: string | null): void {
    this.view.setTask(taskId);
  }
  setBusy(busy: boolean): void {
    this.view.setBusy(busy);
  }
  setStatusText(text: string): void {
    this.view.setStatusText(text);
  }
  append(block: Block): void {
    this.view.append(block);
  }
  /** 开始一次回复（清空运行态） */
  beginTurn(): void {
    this.view.setBusy(true);
    this.view.setStatusText("正在思考");
  }
  endTurn(): void {
    this.view.setBusy(false);
    this.view.setStatusText("");
  }
  /** 在输入框提示一条临时消息（模型连接成功等） */
  toast(text: string): void {
    this.view.blocks.push({ kind: "system", text });
    this.view.paint();
  }
}

export type { Block } from "./app.js";
