/**
 * tui/index.ts — habor 全屏 TUI 控制器。
 *
 * 生命周期：start()（进入 alt screen + raw mode）→ 事件循环（动画 tick）
 * → stop()（恢复终端）。输入经 AppView 处理，提交后回调 CLI。
 */
import { Terminal } from "./vendor/term.js";
import { AppView, type Block } from "./app.js";

export interface TuiControllerOptions {
  version: string;
  /** 提交一行输入（命令或 prompt） */
  onInput: (line: string) => void;
  /** Tab 补全 */
  onComplete?: (line: string) => string[];
  /** Ctrl-C / Esc */
  onInterrupt?: () => void;
}

export class TuiController {
  private term: Terminal;
  view: AppView;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private opts: TuiControllerOptions) {
    this.term = new Terminal();
    this.view = new AppView({
      terminal: this.term,
      version: opts.version,
      onInput: opts.onInput,
      onComplete: opts.onComplete,
      onCancelInput: opts.onInterrupt
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
    this.view.setStatusText("working…");
  }
  endTurn(): void {
    this.view.setBusy(false);
    this.view.setStatusText("idle");
  }
  /** 在输入框提示一条临时消息（模型连接成功等） */
  toast(text: string): void {
    this.view.blocks.push({ kind: "system", text });
    this.view.paint();
  }
}

export type { Block } from "./app.js";
