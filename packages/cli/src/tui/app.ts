/**
 * tui/app.ts — habor 全屏 TUI 视图（opencode/kimi 风格，DeepSeek 蓝白主题）。
 *
 * 布局：标题栏 / 消息区（可滚动）/ 输入框 / 状态栏。
 * 基于 vendored term.js（cell buffer + 终端 diff 刷新）与 markdown.js。
 * 数据源：统一 AgentEvent 流（user/assistant/tool/thinking/usage），
 * 与 harness 无关（TaskRouter 层之上）。
 */
import { Screen, makeStyle, mergeStyle } from "./vendor/term.js";
import { displayWidth, truncateWidth } from "./vendor/util.js";
import { renderMarkdown } from "./vendor/markdown.js";

// DeepSeek 蓝白暗色主题（与 dsh-oc-tui 一致）
export const THEME = {
  primary: "4d6bfe",
  secondary: "6c9cff",
  accent: "7c9cff",
  error: "e06c75",
  warning: "e8c468",
  success: "7fd88f",
  info: "56b6c2",
  text: "f0f4ff",
  textMuted: "8a93a8",
  background: "0a0e18",
  backgroundPanel: "111a2c",
  backgroundElement: "1b2740",
  border: "3d4d73",
  markdownHeading: "7c9cff",
  markdownLinkText: "6c9cff",
  markdownCode: "7fd88f",
  markdownCodeBlock: "f0f4ff",
  markdownBlockQuote: "9fb0d8",
  markdownListItem: "4d6bfe",
  thinking: "9aa6c2",
  codeBg: "1b2740"
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (strs[i].indexOf(prefix) !== 0) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

export type BlockKind = "user" | "assistant" | "tool" | "thinking" | "usage" | "system";

export interface Block {
  kind: BlockKind;
  text: string; // assistant/user 文本（增量累积）；tool 的命令；usage 的展示文本
  meta?: { name?: string; status?: string; delta?: string };
  lines?: { text: string; style: any }[][]; // 已渲染的 markdown 行（缓存）
  wrapped?: boolean;
}

/** 布局区域 */
interface Layout {
  cols: number;
  rows: number;
  headerH: number;
  composerH: number;
  statusH: number;
  transcriptTop: number;
  transcriptBottom: number;
  transcriptH: number;
}

export interface AppViewOptions {
  terminal: any; // Terminal 实例（vendored term.js）
  version: string;
  onInput: (line: string) => void; // 输入提交（命令或 prompt）
  onComplete?: (line: string) => string[]; // Tab 补全
  onCancelInput?: () => void;
}

export class AppView {
  private term: any;
  private version: string;
  private onInput: (line: string) => void;
  private onComplete: (line: string) => string[];
  private onCancelInput: (() => void) | undefined;

  blocks: Block[] = [];
  input = "";
  status: "idle" | "running" = "idle";
  statusText = "";
  model: string | null = null;
  taskId: string | null = null;
  scroll = 0;
  atBottom = true;
  private frame = 0;
  private spinnerT = 0;
  suggestions: string[] | null = null;

  constructor(opts: AppViewOptions) {
    this.term = opts.terminal;
    this.version = opts.version;
    this.onInput = opts.onInput;
    this.onComplete = opts.onComplete ?? (() => []);
    this.onCancelInput = opts.onCancelInput;
  }

  // —— 对外数据接口 ——

  setModel(model: string | null): void {
    this.model = model;
  }
  setTask(taskId: string | null): void {
    this.taskId = taskId;
  }
  setStatusText(text: string): void {
    this.statusText = text;
  }

  /** 追加一条统一 AgentEvent 对应的块（由 CLI 事件循环调用）。 */
  append(block: Block): void {
    // 同种相邻块合并（assistant 流式增量）
    const last = this.blocks[this.blocks.length - 1];
    if (block.kind === "assistant" && last?.kind === "assistant" && block.meta?.delta) {
      last.text += block.meta.delta;
      last.wrapped = false;
    } else if (block.kind === "thinking" && last?.kind === "thinking") {
      last.text += block.meta?.delta ?? block.text;
    } else {
      this.blocks.push(block);
    }
    if (this.atBottom) this.scroll = 0;
    this.paint();
  }

  clearMessages(): void {
    this.blocks = [];
    this.paint();
  }

  setInput(text: string): void {
    this.input = text;
    this.suggestions = null;
    this.paint();
  }

  setBusy(busy: boolean): void {
    this.status = busy ? "running" : "idle";
    if (busy) this.spinnerT = 0;
    this.paint();
  }

  /** 每秒动画帧 */
  tick(): void {
    this.frame++;
    if (this.status === "running") this.spinnerT++;
    // 只要有任何动画（spinner / 运行中）就重绘
    const hasSpinner = this.status === "running" || this.blocks.some((b) => b.kind === "tool" && b.meta?.status === "running");
    if (hasSpinner) this.paint();
  }

  // —— 输入 ——

  handleKey(key: { name?: string; ctrl?: boolean; text?: string }): boolean {
    /* debug removed */
    const k = key.name;
    if (this.status === "running") {
      // 运行中仅允许 Ctrl-C / Esc（打断）
      if (k === "c" && key.ctrl) {
        this.onCancelInput?.();
        return true;
      }
      return true;
    }
    if (k === "return") {
      this.submit();
      return true;
    }
    if (k === "tab") {
      this.complete();
      return true;
    }
    if (k === "backspace") {
      this.input = this.input.slice(0, -1);
      this.suggestions = null;
      this.paint();
      return true;
    }
    if (k === "up") {
      if (this.scroll < this.blocks.length - 1) {
        this.scroll++;
        this.atBottom = false;
        this.paint();
      }
      return true;
    }
    if (k === "down") {
      if (this.scroll > 0) {
        this.scroll--;
        this.atBottom = this.scroll === 0;
        this.paint();
      }
      return true;
    }
    if (k === "c" && key.ctrl) {
      this.onCancelInput?.();
      return true;
    }
    if (k === "escape") {
      if (this.input) {
        this.input = "";
        this.suggestions = null;
        this.paint();
      }
      return true;
    }
    if (k === "space") {
      this.input += " ";
      this.suggestions = null;
      this.paint();
      return true;
    }
    if (k && k.length === 1) {
      this.input += k;
      this.suggestions = null;
      this.paint();
      return true;
    }
    if (key.text && key.text.length >= 1 && key.text >= " ") {
      this.input += key.text;
      this.suggestions = null;
      this.paint();
      return true;
    }
    return false;
  }

  private submit(): void {
    const text = this.input.trim();
    this.input = "";
    this.suggestions = null;
    this.atBottom = true;
    this.scroll = 0;
    this.paint();
    if (text) this.onInput(text);
  }

  private complete(): void {
    const matches = this.onComplete(this.input);
    if (matches.length === 1) {
      this.input = matches[0];
      this.suggestions = null;
      this.paint();
    } else if (matches.length > 1) {
      // 最长公共前缀：能扩展就扩展，否则显示候选
      const common = longestCommonPrefix(matches);
      if (common.length > this.input.length) {
        this.input = common;
        this.suggestions = null;
        this.paint();
      } else {
        this.suggestions = matches;
        this.paint();
      }
    } else {
      this.suggestions = null;
      this.paint();
    }
  }

  // —— 渲染 ——

  private layout(): Layout {
    const cols = this.term.cols;
    const rows = this.term.rows;
    const headerH = 1;
    const composerH = this.suggestions && this.suggestions.length > 0 ? 4 : 2;
    const statusH = 1;
    const transcriptTop = headerH;
    const transcriptBottom = rows - composerH - statusH;
    return {
      cols,
      rows,
      headerH,
      composerH,
      statusH,
      transcriptTop,
      transcriptBottom,
      transcriptH: Math.max(0, transcriptBottom - transcriptTop)
    };
  }

  private renderBlockLines(block: Block, width: number): { text: string; style: any }[][] {
    if (!block.wrapped) {
      if (block.kind === "assistant" || block.kind === "user") {
        block.lines = renderMarkdown(block.text, THEME as any, width);
      } else if (block.kind === "thinking") {
        block.lines = renderMarkdown(block.text, { ...THEME, markdownText: THEME.thinking } as any, width);
      } else {
        block.lines = renderMarkdown(block.text, THEME as any, width);
      }
      block.wrapped = true;
    }
    return block.lines ?? [];
  }

  paint(): void {
    const layout = this.layout();
    const { cols, rows, headerH, transcriptTop, transcriptBottom, transcriptH, composerH } = layout;
    const screen = new Screen(cols, rows);
    const t = THEME;
    screen.clear(makeStyle({ bg: t.background }));

    // —— 标题栏 ——
    const headerStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel });
    screen.fill(0, 0, cols, " ", headerStyle);
    let hx = 2;
    hx = screen.text(hx, 0, "◈ ", makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel }));
    hx = screen.text(hx, 0, `habor v${this.version}`, makeStyle({ fg: t.text, bold: true, bg: t.backgroundPanel }));
    const modelInfo = this.model ?? "未选模型";
    const modelX = cols - displayWidth(modelInfo) - 2;
    if (modelX > hx) {
      screen.text(modelX, 0, modelInfo, makeStyle({ fg: t.accent, bg: t.backgroundPanel }));
      screen.fillToEnd(modelX + displayWidth(modelInfo), 0, headerStyle);
    } else {
      screen.fillToEnd(hx, 0, headerStyle);
    }
    if (this.taskId) {
      screen.text(modelX - displayWidth(this.taskId) - 2, 0, this.taskId, makeStyle({ fg: t.info, bg: t.backgroundPanel }));
    }

    // —— 消息区 ——
    const renderWidth = cols - 4; // 左右留白
    // 计算所有块的总行数，支持滚动
    const allLines: { block: Block; lines: { text: string; style: any }[][] }[] = [];
    for (const b of this.blocks) {
      allLines.push({ block: b, lines: this.renderBlockLines(b, renderWidth) });
    }
    // 总高度（含块间空行）
    let total = 0;
    for (const { lines } of allLines) total += lines.length + 1;
    const maxScroll = Math.max(0, total - transcriptH);
    this.scroll = Math.min(this.scroll, maxScroll);
    if (this.atBottom) this.scroll = 0;

    let y = transcriptTop - this.scroll;
    const drawLine = (lineSegs: { text: string; style: any }[], yy: number, prefix?: { text: string; style: any } | undefined) => {
      if (yy < transcriptTop || yy >= transcriptBottom) return;
      let x = 2;
      if (prefix) x = screen.text(x, yy, prefix.text, prefix.style);
      for (const seg of lineSegs) {
        x = screen.text(x, yy, seg.text, seg.style);
      }
      screen.fillToEnd(x, yy, makeStyle({ bg: t.background }));
    };

    for (const { block, lines } of allLines) {
      const styleFor = (base: string, bold = false) => makeStyle({ fg: base, bold, bg: t.background });
      if (block.kind === "user") {
        for (const line of lines) {
          drawLine(line, y, { text: "✨ ", style: styleFor(t.secondary, true) });
          y++;
        }
        y++; // 空行
      } else if (block.kind === "assistant") {
        let prefix: { text: string; style: any } | undefined = { text: "● ", style: styleFor(t.primary, true) };
        for (const line of lines) {
          drawLine(line, y, prefix);
          prefix = undefined;
          y++;
        }
        y++;
      } else if (block.kind === "thinking") {
        const first = true;
        for (const line of lines) {
          const prefix = first ? { text: "┈ 思考 ", style: styleFor(t.thinking) } : undefined;
          drawLine(line, y, prefix);
          y++;
        }
        y++;
      } else if (block.kind === "tool") {
        const running = block.meta?.status === "running";
        const name = block.meta?.name ?? "tool";
        const spinner = running ? ` ${SPINNER[this.spinnerT % SPINNER.length]}` : "";
        drawLine(
          [{ text: `${running ? "" : "✓ "}⚙ ${name}${spinner}`, style: styleFor(running ? t.warning : t.success) }],
          y
        );
        y++;
        // 工具内容（截断展示）
        const body = block.text.slice(0, 200);
        if (body) {
          for (const line of renderMarkdown(body, THEME as any, renderWidth - 2)) {
            drawLine(line, y, { text: "  ", style: styleFor(t.textMuted) });
            y++;
          }
        }
        y++;
      } else if (block.kind === "usage") {
        drawLine([{ text: block.text, style: makeStyle({ fg: t.textMuted, dim: true }) }], y);
        y++;
        y++;
      } else {
        for (const line of lines) {
          drawLine(line, y);
          y++;
        }
        y++;
      }
    }

    // —— 输入框 ——
    const composerTop = rows - composerH - 1;
    const compStyle = makeStyle({ fg: t.text, bg: t.backgroundElement });
    for (let yy = composerTop; yy < rows - 1; yy++) {
      screen.fill(0, yy, cols, " ", makeStyle({ bg: t.backgroundElement }));
    }
    screen.text(1, composerTop, "❯ ", makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }));
    screen.text(3, composerTop, this.input, compStyle);
    screen.fillToEnd(3 + displayWidth(this.input), composerTop, makeStyle({ bg: t.backgroundElement }));

    // 补全建议
    if (this.suggestions && this.suggestions.length > 0) {
      const shown = this.suggestions.slice(0, 6).join("   ");
      screen.text(1, composerTop + 1, shown, makeStyle({ fg: t.accent, bg: t.backgroundElement }));
    } else {
      screen.text(1, composerTop + 1, this.status === "running" ? SPINNER[this.spinnerT % SPINNER.length] + " 运行中…" : "输入 / 或 Tab 补全 · ↑↓ 滚动", makeStyle({ fg: t.textMuted, bg: t.backgroundElement }));
    }

    // —— 状态栏 ——
    screen.fill(0, rows - 1, cols, " ", makeStyle({ bg: t.backgroundPanel }));
    const statusText = this.statusText || (this.status === "running" ? "working…" : "idle");
    screen.text(1, rows - 1, statusText, makeStyle({ fg: this.status === "running" ? t.warning : t.textMuted, bg: t.backgroundPanel }));
    screen.fillToEnd(1 + displayWidth(statusText), rows - 1, makeStyle({ bg: t.backgroundPanel }));

    this.term.paint(screen);
  }
}
