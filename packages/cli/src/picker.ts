/**
 * cli/src/picker.ts — kimi-code 风格的可搜索列表选择器。
 *
 * 交互（与 kimi-code 的 ModelSelector 一致）：
 *   ↑/↓ 或 j/k  移动选择
 *   直接打字      过滤列表（大小写不敏感）
 *   Backspace    删除过滤字符
 *   Enter        确认选择
 *   Esc          取消（返回 null）
 *
 * 实现：复用 readline 的 keypress 事件（raw 模式下由 readline 在 stdin 上
 * 派发），避免与 readline 的 line 模式双重消费 stdin。
 */

export interface PickItem<T> {
  value: T;
  label: string;
  hint?: string;
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const PAGE = 10;

/** 可搜索选择器：解析为选中值，Esc/空列表/非 TTY → null。 */
export function pick<T>(opts: {
  title: string;
  items: PickItem<T>[];
  currentValue?: T;
  /** 输入层暂停/恢复（raw 模式期间挂起 line 输入，避免双重消费） */
  rl: { pause(): void; resume(): void };
}): Promise<T | null> {
  const { title, items, rl } = opts;
  if (items.length === 0) return Promise.resolve(null);
  if (!process.stdin.isTTY) return Promise.resolve(null);

  return new Promise<T | null>((resolve) => {
    const prevRaw = process.stdin.isRaw;
    // 同步 readline 内部的 raw 状态：直接 setRawMode 不会更新 rl._rawMode，
    // 会导致 Enter 仍按 line 模式处理（发出残留 line 事件）
    const rlAny = rl as unknown as { _rawMode?: boolean };
    const prevRlRaw = rlAny._rawMode ?? false;
    rl.pause();
    process.stdin.setRawMode?.(true);
    rlAny._rawMode = true;
    process.stdin.resume();

    let filtered = [...items];
    let cursor = Math.max(0, items.findIndex((i) => i.value === opts.currentValue));
    let query = "";
    let finished = false;

    const finish = (value: T | null) => {
      if (finished) return;
      finished = true;
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode?.(prevRaw);
      rlAny._rawMode = prevRlRaw;
      rl.resume();
      process.stdin.resume();
      const h = boxHeight();
      if (h > 0) process.stdout.write(`\x1b[${h}A\x1b[J`);
      process.stdout.write(SHOW_CURSOR);
      resolve(value);
    };

    const boxHeight = () => 3 + Math.min(filtered.length, PAGE);

    const render = () => {
      const start = Math.max(0, cursor - (PAGE - 1));
      const end = Math.min(filtered.length, start + PAGE);
      const lines: string[] = [];
      lines.push(`\x1b[1m${title}\x1b[0m${query ? `  \x1b[90m过滤: ${query}\x1b[0m` : ""}`);
      lines.push(`\x1b[90m↑/↓ 选择 · 直接输入过滤 · Enter 确认 · Esc 取消\x1b[0m`);
      for (let i = start; i < end; i++) {
        const item = filtered[i];
        const mark = i === cursor ? "❯" : " ";
        const style = i === cursor ? "\x1b[36m" : "\x1b[90m";
        lines.push(`${style}${mark} ${item.label}\x1b[0m${item.hint ? `  \x1b[2m${item.hint}\x1b[0m` : ""}`);
      }
      process.stdout.write(HIDE_CURSOR);
      process.stdout.write(`\x1b[${boxHeight()}A\x1b[J`);
      process.stdout.write(lines.join("\n") + "\n");
    };

    const applyFilter = () => {
      const q = query.trim().toLowerCase();
      filtered = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : [...items];
      if (filtered.length === 0) {
        filtered = [...items];
        query = "";
      }
      cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
      render();
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === "up" || key.name === "k") {
        if (filtered.length > 0) cursor = (cursor - 1 + filtered.length) % filtered.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        if (filtered.length > 0) cursor = (cursor + 1) % filtered.length;
        render();
      } else if (key.name === "return") {
        finish(filtered[cursor]?.value ?? null);
      } else if (key.name === "escape") {
        finish(null);
      } else if (key.ctrl && key.name === "c") {
        process.exit(130);
      } else if (key.name === "backspace") {
        query = query.slice(0, -1);
        applyFilter();
      } else if (key.name === "space") {
        query += " ";
        applyFilter();
      } else if (key.name && key.name.length === 1) {
        query += key.name;
        applyFilter();
      }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}
