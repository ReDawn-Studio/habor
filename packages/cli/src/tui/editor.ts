import { displayWidth, graphemes, runeWidth } from "./vendor/util.js";

export interface InputLine { text: string; start: number; end: number }

/** UTF-16 offsets at grapheme boundaries keep CJK, emoji and IME text intact. */
export class InputEditor {
  text = "";
  cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = "";

  set(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }
  insert(text: string): void {
    const clean = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
    this.cursor += clean.length;
  }
  left(): void {
    this.cursor -= graphemes(this.text.slice(0, this.cursor)).at(-1)?.length ?? 0;
  }
  right(): void {
    this.cursor += graphemes(this.text.slice(this.cursor))[0]?.length ?? 0;
  }
  backspace(): void {
    const end = this.cursor;
    this.left();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }
  delete(): void {
    const start = this.cursor;
    this.right();
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }
  home(): void { this.cursor = this.text.slice(0, this.cursor).lastIndexOf("\n") + 1; }
  end(): void {
    const end = this.text.indexOf("\n", this.cursor);
    this.cursor = end < 0 ? this.text.length : end;
  }
  deleteBefore(): void { this.text = this.text.slice(this.cursor); this.cursor = 0; }
  deleteAfter(): void { this.text = this.text.slice(0, this.cursor); }
  deleteWord(): void {
    const before = this.text.slice(0, this.cursor);
    const start = before.replace(/\s*\S+\s*$/u, "").length;
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }
  remember(text: string): void {
    if (this.history.at(-1) !== text) this.history.push(text);
    if (this.history.length > 200) this.history.shift();
    this.historyIndex = this.history.length;
    this.draft = "";
  }
  recall(direction: -1 | 1): void {
    if (this.historyIndex === this.history.length) this.draft = this.text;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.set(this.history[this.historyIndex] ?? this.draft);
  }
  lines(width: number): InputLine[] {
    const lines: InputLine[] = [];
    let text = "", start = 0, offset = 0, cells = 0;
    for (const ch of graphemes(this.text)) {
      const w = runeWidth(ch);
      if (ch === "\n" || cells + w > width) {
        lines.push({ text, start, end: offset });
        text = ""; cells = 0; start = offset;
        if (ch === "\n") { offset += ch.length; start = offset; continue; }
      }
      text += ch; cells += w; offset += ch.length;
    }
    lines.push({ text, start, end: offset });
    if (cells >= width) lines.push({ text: "", start: offset, end: offset });
    return lines;
  }
  position(lines: InputLine[]): { row: number; col: number } {
    let row = 0;
    for (let i = 0; i < lines.length; i++) if (lines[i].start <= this.cursor) row = i;
    return { row, col: displayWidth(this.text.slice(lines[row].start, this.cursor)) };
  }
  vertical(direction: -1 | 1, width: number): boolean {
    const lines = this.lines(width);
    const { row, col } = this.position(lines);
    const next = lines[row + direction];
    if (!next) return false;
    let cells = 0;
    this.cursor = next.start;
    for (const ch of graphemes(next.text)) {
      cells += runeWidth(ch);
      if (cells > col) break;
      this.cursor += ch.length;
    }
    return true;
  }
}
