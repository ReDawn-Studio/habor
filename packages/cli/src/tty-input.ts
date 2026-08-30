/**
 * cli/src/tty-input.ts — kimi 风格的自建 TTY 输入层。
 *
 * readline 的 line 模式下 Tab 不触发 completer（keypress 只在 raw 模式派发），
 * 无法做命令/模型推断。这里自建输入层（raw 模式 + keypress）：
 *
 *   - 输入行渲染：`❯ ` + 当前输入（每键重绘）
 *   - Tab：补全（唯一候选直接替换；多候选在下方灰色显示一行）
 *   - 输入 `/`：自动弹出命令候选（实时推断）
 *   - Enter 提交（onSubmit 期间忽略输入）；Esc 取消当前行；Ctrl-C 退出
 *
 * 非 TTY（管道/脚本）不应使用本层，调用方负责回退。
 */
import * as readline from "node:readline";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K\r";

export interface TtyInputOptions {
  prompt: string;
  /** 补全：返回候选列表；返回空表示无可补全 */
  complete(line: string): string[];
  /** 提交一行（可异步；pending 期间忽略新输入） */
  onSubmit(line: string): Promise<void> | void;
  /** 空行提交（回车）时调用 */
  onEmptyLine?(): void;
  onCancel?(): void;
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (strs[i].indexOf(prefix) !== 0) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

export interface TtyInput {
  /** 暂停输入（打开 picker 等场景） */
  pause(): void;
  resume(): void;
  stop(): void;
}

export function startTtyInput(opts: TtyInputOptions): TtyInput {
  let line = "";
  let candidates: string[] | null = null;
  let busy = false;
  let paused = false;
  let stopped = false;

  const prompt = opts.prompt;

  const render = () => {
    process.stdout.write(HIDE + CLEAR_LINE + prompt + line + SHOW);
  };
  const renderCandidates = () => {
    // 先清输入行，再在下一行打印候选，然后回到输入行重画
    process.stdout.write(CLEAR_LINE + prompt + line + "\n");
    if (candidates && candidates.length > 0) {
      const shown = candidates.slice(0, 8).join("   ");
      process.stdout.write(`\x1b[90m${shown}\x1b[0m\n`);
    }
    process.stdout.write(prompt + line);
  };

  const submit = async () => {
    const text = line;
    line = "";
    candidates = null;
    render();
    if (text.trim() === "") {
      opts.onEmptyLine?.();
      return;
    }
    busy = true;
    try {
      await opts.onSubmit(text);
    } finally {
      busy = false;
      if (!stopped) render();
    }
  };

  const doComplete = () => {
    const matches = opts.complete(line);
    if (matches.length === 1) {
      line = matches[0];
      candidates = null;
      render();
    } else if (matches.length > 1) {
      // 最长公共前缀：能扩展就扩展，否则显示候选
      const common = longestCommonPrefix(matches);
      if (common.length > line.length) {
        line = common;
        candidates = null;
        render();
      } else {
        candidates = matches;
        renderCandidates();
        candidates = null;
        render();
      }
    } else {
      candidates = null;
      render();
    }
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
    if (process.env.HABOR_DEBUG_TTY) console.error("[tty] str=", JSON.stringify(_str), "name=", key?.name);
    if (busy || paused || stopped) return;
    const k = key.name;
    if (k === "return") {
      void submit();
    } else if (k === "tab") {
      doComplete();
    } else if (k === "backspace") {
      line = line.slice(0, -1);
      render();
    } else if (k === "escape") {
      if (line) {
        line = "";
        render();
      } else {
        opts.onCancel?.();
      }
    } else if (k === "c" && key.ctrl) {
      process.stdout.write("\n");
      process.exit(130);
    } else if (k === "space") {
      line += " ";
      render();
    } else if (k === "d" && key.ctrl) {
      // Ctrl-D：EOF 退出
      process.stdout.write("\n");
      process.exit(0);
    } else if (k && k.length === 1) {
      line += k;
      render();
    } else if (_str && _str.length === 1 && _str >= " ") {
      // 斜杠等 key.name 为 undefined 的字符：用 str 判断
      line += _str;
      render();
    }
  };

  process.stdin.on("keypress", onKeypress);
  render();

  return {
    pause() {
      paused = true;
      process.stdout.write(HIDE);
    },
    resume() {
      paused = false;
      if (!busy) render();
    },
    stop() {
      stopped = true;
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode?.(false);
      process.stdout.write(SHOW);
    }
  };
}
