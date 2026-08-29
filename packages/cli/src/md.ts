/**
 * cli/src/md.ts — 轻量流式 markdown 渲染（Claude Code 风格）。
 *
 * 流式策略：按行缓冲 —— 未完成的行原样输出（避免半截标记闪烁），
 * 行结束时对该行做 inline markdown 渲染；``` 代码块整块保持原样 + 青色。
 */
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`
};

/** 行内 markdown：`code`、**bold**、*italic*、[text](url) */
export function renderInline(s: string): string {
  let out = s;
  // 行内代码（先处理，避免污染其它标记）
  out = out.replace(/`([^`]+)`/g, (_, code: string) => C.cyan(code));
  // 加粗
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => C.bold(t));
  // 斜体
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre: string, t: string) => `${pre}${C.italic(t)}`);
  // 链接：[text](url) → text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, t: string) => C.cyan(t));
  return out;
}

export class MdStream {
  private buf = "";
  private inCode = false;

  /** 追加增量，返回可以安全输出的已渲染文本。 */
  push(delta: string): string {
    this.buf += delta;
    let out = "";
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      out += this.renderLine(line) + "\n";
    }
    return out;
  }

  /** 冲刷剩余未完成的行（流结束时调用）。 */
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    if (rest === "") return "";
    return this.renderLine(rest);
  }

  private renderLine(line: string): string {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      this.inCode = !this.inCode;
      return C.dim(line);
    }
    if (this.inCode) return C.cyan(line);
    // 标题
    if (/^#{1,3}\s/.test(line)) return C.bold(line);
    if (/^#{4,6}\s/.test(line)) return C.bold(C.gray(line));
    // 引用
    if (/^>\s?/.test(line)) return C.gray(line);
    // 无序列表
    if (/^\s*[-*+]\s/.test(line)) {
      return "  " + renderInline(line.replace(/^\s*[-*+]\s/, "• "));
    }
    // 有序列表
    if (/^\s*\d+[.)]\s/.test(line)) {
      return "  " + renderInline(line);
    }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return C.gray(line);
    return renderInline(line);
  }
}
