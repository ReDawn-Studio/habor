import { displayWidth, graphemes } from "./vendor/util.js";

export interface SelectionPoint { row: number; col: number }

/** Cell coordinates against a frozen transcript, independent of its viewport. */
export class TranscriptSelection {
  private anchor: SelectionPoint;
  private focus: SelectionPoint;
  private moved = false;
  dragging = true;

  constructor(readonly lines: string[], readonly width: number, point: SelectionPoint) {
    this.anchor = this.focus = this.clamp(point);
  }

  private clamp(point: SelectionPoint): SelectionPoint {
    return { row: Math.max(0, Math.min(this.lines.length - 1, point.row)), col: Math.max(0, Math.min(this.width - 1, point.col)) };
  }

  extend(point: SelectionPoint): void {
    this.focus = this.clamp(point);
    this.moved ||= this.focus.row !== this.anchor.row || this.focus.col !== this.anchor.col;
  }

  /** Half-open cell range, expanded so a CJK/emoji grapheme is never split. */
  range(row: number): { start: number; end: number } | undefined {
    if (!this.moved) return;
    const forward = this.anchor.row < this.focus.row || (this.anchor.row === this.focus.row && this.anchor.col <= this.focus.col);
    const [first, last] = forward ? [this.anchor, this.focus] : [this.focus, this.anchor];
    if (row < first.row || row > last.row) return;
    let start = row === first.row ? first.col : 0;
    let end = row === last.row ? last.col + 1 : this.width;
    let col = 0;
    for (const ch of graphemes(this.lines[row] ?? "")) {
      const next = col + displayWidth(ch);
      if (col < start && next > start) start = col;
      if (col < end && next > end) end = next;
      col = next;
    }
    return { start, end };
  }

  text(): string {
    if (!this.moved) return "";
    const lines: string[] = [];
    for (let row = Math.min(this.anchor.row, this.focus.row); row <= Math.max(this.anchor.row, this.focus.row); row++) {
      const range = this.range(row)!;
      let col = 0, text = "";
      for (const ch of graphemes(this.lines[row] ?? "")) {
        const next = col + displayWidth(ch);
        if (next > range.start && col < range.end) text += ch;
        col = next;
      }
      lines.push(text.trimEnd());
    }
    return lines.join("\n");
  }
}
