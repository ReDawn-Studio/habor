import type { Key } from './app.js';
import type { PanelRow } from './provider-panel.js';

export interface ResumeCandidate { id: string; title: string; model: string; messages: number; source?: string }

export class ResumePanel {
  index = 0;
  busy = false;
  error = '';
  readonly title = '恢复当前工作区任务';
  constructor(readonly candidates: ResumeCandidate[], private resume: (id: string) => Promise<void>, private close: () => void, private paint: () => void) {}
  get focusedRow(): number { return 3 + this.index; }
  rows(): PanelRow[] {
    return [
      { text: '只显示当前工作区的历史任务。', tone: 'muted' },
      { text: '恢复后会继续原模型和上下文。', tone: 'muted' },
      { text: '' },
      ...this.candidates.map(candidate => ({ text: `[${candidate.source ?? "habor"}] ${candidate.id} · ${candidate.title} · ${candidate.model} · ${candidate.messages} 条消息`, selected: this.candidates[this.index] === candidate })),
      { text: '' },
      { text: this.busy ? '正在恢复…' : this.error || '↑↓ 选择 · Enter 恢复 · Esc 返回', tone: this.error ? 'error' : 'muted' }
    ];
  }
  handle(key: Key): void {
    if (this.busy) return;
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.close(); return; }
    if (key.name === 'up' || key.name === 'down') this.index = (this.index + (key.name === 'up' ? -1 : 1) + this.candidates.length) % this.candidates.length;
    if (key.name === 'enter' || key.name === 'return') void this.accept();
    this.paint();
  }
  private async accept(): Promise<void> {
    const candidate = this.candidates[this.index]; if (!candidate) return;
    this.busy = true; this.error = ''; this.paint();
    try { await this.resume(candidate.id); this.close(); }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); this.busy = false; this.paint(); }
  }
}
