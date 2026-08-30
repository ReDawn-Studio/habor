#!/usr/bin/env node
/**
 * cli/src/index.ts — habor：原生 Agent 聚合平台 CLI。
 *
 * 产品决策：
 *   - 用户只看到「模型」，agent/harness 是内部实现。
 *   - 任务（Task）是跨 harness 切换保持不变的持久单位：
 *       「继续刚才的任务」永远留在原 session（亲和性），
 *       /model 切换 = 同一任务换绑定，对话不丢。
 *
 * 分层：CLI → TaskRouter（Orchestrator+Router）→ Registry → Adapters（ACP/CLI）
 *
 * 实现注意：readline 的 line/close handler 必须在任何异步工作之前
 * 同步注册，否则管道输入（pipe）的数据会在异步间隔中丢失。
 */
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAdapters } from "@agent-router/adapters";
import { createRouter, listModels, adapterIdForModel, MODEL_CATALOG, type Task } from "@agent-router/router";
import { renderEvent } from "./render.js";
import { pick } from "./picker.js";
import { MdStream } from "./md.js";
import { startTtyInput, type TtyInput } from "./tty-input.js";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`
};

// —— State 层：任务持久化到 ~/.habor/state.jsonl（旧 ~/.myagent 数据自动迁移）——
const stateDir = join(homedir(), ".habor");
const stateFile = join(stateDir, "state.jsonl");
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
if (!existsSync(stateFile)) {
  const legacy = join(homedir(), ".myagent", "state.jsonl");
  if (existsSync(legacy)) {
    try {
      writeFileSync(stateFile, readFileSync(legacy, "utf8"), "utf8");
    } catch { /* 迁移失败则忽略 */ }
  }
}

// —— 路由层：注入全部 adapters，组装 Registry + State + TaskRouter ——
const { router, tasks } = createRouter(createAdapters(), { stateFile });
if (existsSync(stateFile)) {
  try {
    tasks.loadFromJSON(readFileSync(stateFile, "utf8"));
  } catch {
    /* 损坏则忽略 */
  }
}
const cwd = process.cwd();
let permission: "ask" | "auto" = "auto";

let saveTimer: NodeJS.Timeout | null = null;
function persist(force = false): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const write = () => {
    try {
      writeFileSync(stateFile, tasks.toJSON(), "utf8");
    } catch {
      /* 写盘失败不阻塞 */
    }
  };
  if (force) {
    write();
  } else {
    saveTimer = setTimeout(write, 500);
  }
}

let currentTaskId: string | null = null;

const HELP = `
${C.bold("habor")} — 原生 Agent 聚合平台
用户只选「模型」，任务自动跑在对应厂商的原生 agent（harness）里。

命令:
  /model <名字>          选择模型（新任务 或 切换当前任务的执行 harness）
  /models                列出本机可用的模型（及背后的原生 harness）
  /tasks                 列出任务（含绑定链）
  /new                   结束当前任务，开始新任务
  /status                当前任务 + 会话绑定链
  /permission <ask|auto> 权限模式（ask=需要确认；auto=自动执行）
  /help                  帮助
  /quit                  退出
直接输入 = 「继续当前任务」（同一任务永远留在原 session 上执行）。
`;

async function listAvailable(): Promise<string[]> {
  return router.listAvailableModels();
}

function harnessForModel(model: string): string {
  const id = adapterIdForModel(model);
  return id ? id : "?";
}

/** 大小写不敏感 + 模糊解析模型名；命中多个时返回 undefined 表示需要选择器。 */
function resolveModelArg(arg: string, available: string[]): string | undefined {
  const q = arg.trim().toLowerCase();
  if (!q) return undefined;
  const exact = available.find((m) => m.toLowerCase() === q);
  if (exact) return exact;
  const starts = available.filter((m) => m.toLowerCase().startsWith(q));
  if (starts.length === 1) return starts[0];
  const includes = available.filter((m) => m.toLowerCase().includes(q));
  if (includes.length === 1) return includes[0];
  return undefined;
}

/** kimi-code 风格的可搜索模型选择器（TTY 输入层调用时先 pause 自己）。 */
async function selectModelInteractive(title: string): Promise<string | null> {
  const available = await listAvailable();
  if (available.length === 0) {
    console.log(C.red("✗ 没有可用模型（本机 harness 未安装）"));
    return null;
  }
  return pick<string>({
    title,
    items: available.map((m) => {
      const entry = MODEL_CATALOG.find((x) => x.model === m);
      return { value: m, label: m, hint: `${entry?.vendor ?? ""} · ${harnessForModel(m)}` };
    }),
    currentValue: currentTaskId ? router.getTask(currentTaskId)?.bindings.filter((b) => !b.endedAt).at(-1)?.model : undefined,
    // pick 内部会 pause/resume 这个输入层（raw 模式期间不双重消费）
    rl: ttyInput ?? { pause() {}, resume() {} }
  });
}

/** /model：无任务 → 新建任务；有任务 → 同任务切换绑定（亲和性只在此处打破）。 */
async function selectModel(model: string): Promise<void> {
  const available = await listAvailable();
  if (!available.includes(model)) {
    console.log(C.red(`✗ 模型不可用: ${model}`));
    console.log(C.gray(`  当前可用: ${available.join(", ") || "（无）"}`));
    return;
  }
  const entry = MODEL_CATALOG.find((m) => m.model === model);
  if (!currentTaskId) {
    const task = await router.newTask({ model, cwd, permission });
    currentTaskId = task.id;
    console.log(
      C.green(`✓ 新任务 ${task.id} · 已连接: ${model}`) +
        C.gray(`  → 在 ${harnessForModel(model)}（${entry?.display ?? ""}）中执行`)
    );
  } else {
    const before = router.getTask(currentTaskId);
    const oldTarget = before ? before.bindings.filter((b) => !b.endedAt).at(-1) : undefined;
    await router.switchTaskModel(currentTaskId, model, { permission });
    console.log(
      C.yellow(`⇄ 切换当前任务到: ${model}`) +
        C.gray(`（${oldTarget ? `原 ${oldTarget.model} 会话已关闭，上下文快照已保存` : ""}）`)
    );
  }
  persist();
}

async function handleCommand(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/help":
      console.log(HELP);
      return true;
    case "/models": {
      const available = await listAvailable();
      console.log(C.bold("\n可用模型（背后自动对应原生 harness）:"));
      for (const m of listModels()) {
        const ok = available.includes(m);
        const entry = MODEL_CATALOG.find((x) => x.model === m);
        console.log(`  ${ok ? "○" : C.dim("×")} ${C.bold(m)}${C.gray(` → ${harnessForModel(m)}`)}`);
        console.log(C.gray(`      ${entry?.vendor} · ${entry?.display ?? ""}`));
      }
      console.log();
      return true;
    }
    case "/model":
      if (!arg) {
        if (process.stdin.isTTY) {
          const picked = await selectModelInteractive("选择模型（直接输入过滤）");
          if (picked) await selectModel(picked);
        } else {
          const available = await listAvailable();
          console.log(C.bold("\n可用模型:"));
          available.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
          console.log(C.gray("用法: /model <模型名>（支持大小写/模糊，如 /model glm）"));
        }
      } else {
        const available = await listAvailable();
        const resolved = resolveModelArg(arg, available);
        if (resolved) {
          await selectModel(resolved);
        } else {
          // 歧义或未命中：弹选择器（已按输入过滤）
          console.log(C.yellow(`「${arg}」未能唯一匹配，请选择:`));
          const picked = await selectModelInteractive(`选择模型（过滤: ${arg}）`);
          if (picked) await selectModel(picked);
        }
      }
      return true;
    case "/tasks": {
      const list = router.listTasks();
      if (list.length === 0) {
        console.log(C.yellow("（暂无任务，用 /model 开始一个）"));
        return true;
      }
      console.log(C.bold("\n任务（State 层：Task / 绑定链 / 对话轮数）:"));
      for (const t of list) {
        const mark = t.id === currentTaskId ? C.green("●") : "○";
        const active = t.bindings.filter((b) => !b.endedAt).at(-1);
        console.log(
          `  ${mark} ${C.bold(t.id)}  ${t.title}${t.id === currentTaskId ? C.green("  ← 当前") : ""}`
        );
        console.log(C.gray(`      对话 ${t.conversation.length} 轮 · 快照 ${t.contextSnapshots.length} · 绑定链:`));
        for (const b of t.bindings) {
          console.log(
            C.gray(
              `        ${b.model} @ ${b.adapterId} (${b.sessionId}) [${b.reason}]${b.endedAt ? " 已结束" : " 活跃"}`
            )
          );
        }
      }
      console.log();
      return true;
    }
    case "/new": {
      if (currentTaskId) {
        const t = router.getTask(currentTaskId);
        if (t) {
          await router.finishTask(currentTaskId, "done");
          console.log(C.green(`✓ 任务 ${currentTaskId} 已结束`));
        }
        currentTaskId = null;
      }
      console.log(C.gray("新任务：用 /model 选择模型开始。"));
      persist();
      return true;
    }
    case "/status": {
      if (!currentTaskId) {
        console.log(C.yellow("尚无当前任务。用 /model 选择一个模型。"));
        return true;
      }
      const { task, target } = router.status(currentTaskId);
      console.log(C.bold(`任务: ${task.id}`) + C.gray(`  ${task.title}`));
      console.log(`  状态: ${task.status} · 对话 ${task.conversation.length} 轮`);
      if (target) {
        console.log(
          `  当前绑定: ${C.bold(target.model)} → harness ${C.cyan(target.adapterId)} (session ${target.sessionId})`
        );
      }
      console.log(`  权限: ${permission}`);
      return true;
    }
    case "/permission":
      if (arg === "ask" || arg === "auto") {
        permission = arg;
        console.log(C.green(`✓ 权限模式: ${permission}`));
      } else {
        console.log(C.yellow("用法: /permission ask|auto"));
      }
      return true;
    case "/quit":
    case "/exit":
      return false;
    default:
      console.log(C.yellow(`未知命令: ${cmd}（/help 查看帮助）`));
      return true;
  }
}

async function runPrompt(text: string): Promise<void> {
  if (!currentTaskId) {
    console.log(C.yellow("先用 /model 选择一个模型开始任务。"));
    return;
  }
  const md = new MdStream(); // 流式 markdown（Claude Code 风格）
  const INDENT = "  "; // kimi MESSAGE_INDENT：续行缩进，对齐 bullet 后的内容
  let inAssistant = false; // 消息段
  let inThinking = false; // 思考段（与消息段互斥）
  const endThinking = () => {
    if (inThinking) {
      process.stdout.write("\n");
      inThinking = false;
    }
  };
  const writeMd = (out: string) => {
    if (!out) return;
    const lines = out.split("\n");
    process.stdout.write(lines[0]);
    for (let i = 1; i < lines.length; i++) {
      process.stdout.write("\n" + (lines[i] ? INDENT + lines[i] : ""));
    }
  };
  const flushText = () => {
    const rest = md.flush();
    if (rest) writeMd(rest);
  };
  try {
    for await (const ev of router.continueTask(currentTaskId, text)) {
      if (ev.type === "message") {
        endThinking();
        if (!inAssistant) {
          process.stdout.write(C.cyan("● ")); // kimi STATUS_BULLET
          inAssistant = true;
        }
        writeMd(md.push(ev.delta ?? ev.text ?? ""));
      } else if (ev.type === "done") {
        endThinking();
        flushText();
        if (inAssistant) process.stdout.write("\n");
        inAssistant = false;
        process.stdout.write("\n");
        persist();
      } else if (ev.type === "thinking") {
        // 思考段：灰色标签 + 斜体内容（只打一次前缀）
        if (inAssistant) {
          flushText();
          process.stdout.write("\n");
          inAssistant = false;
        }
        if (!inThinking) {
          process.stdout.write(C.gray("┈ 思考 ") + `\x1b[2;3m`);
          inThinking = true;
        }
        process.stdout.write(ev.thinking ?? "");
      } else {
        // 工具/usage/错误：结束所有段，先冲刷文本
        endThinking();
        flushText();
        if (inAssistant) process.stdout.write("\n");
        inAssistant = false;
        const rendered = renderEvent(ev);
        if (rendered) console.log(rendered);
      }
    }
  } catch (err) {
    endThinking();
    console.log(C.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  }
}

// —— 统一输入分发：一行命令或 prompt，返回是否继续 ——
let quitRequested = false;
async function dispatch(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    if (trimmed.startsWith("/")) {
      const cont = await handleCommand(trimmed);
      if (!cont) {
        quitRequested = true;
        bye();
      }
    } else {
      await runPrompt(trimmed);
    }
  } catch (err) {
    console.log(C.red(`✗ 内部错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
  }
}

let byeOnce = false;
function bye(): void {
  if (byeOnce) return;
  byeOnce = true;
  persist(true);
  console.log("\nbye");
  process.exit(0);
}

// —— 输入层：TTY 用 kimi 风格自建输入（Tab 补全 + / 命令推断）；非 TTY 用 readline ——
const COMMANDS = ["model", "models", "new", "status", "tasks", "permission", "help", "quit", "exit"];
function completeLine(line: string): string[] {
  if (line.startsWith("/model ")) {
    const q = line.slice(7).trim().toLowerCase();
    return listModels()
      .filter((m) => m.toLowerCase().includes(q))
      .map((m) => `/model ${m}`);
  }
  if (line.startsWith("/")) {
    const q = line.slice(1).toLowerCase();
    return COMMANDS.filter((c) => c.startsWith(q)).map((c) => `/${c}`);
  }
  return [];
}

let ttyInput: TtyInput | null = null;

function startInput(): void {
  if (process.stdin.isTTY) {
    ttyInput = startTtyInput({
      prompt: `${C.cyan("❯")} `,
      complete: completeLine,
      onSubmit: async (line) => {
        await dispatch(line);
        ttyInput?.resume();
      },
      onEmptyLine: () => ttyInput?.resume(),
      onCancel: () => {}
    });
  } else {
    // 非 TTY（管道/脚本）：readline 逐行 + 串行队列（async handler 与 close 抢跑问题）
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt(`${C.cyan("❯")} `);
    const queue: string[] = [];
    let closed = false;
    let draining = false;
    const pump = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const line = queue.shift()!;
          if (quitRequested) break;
          await dispatch(line);
        }
      } finally {
        draining = false;
      }
      if (closed && queue.length === 0 && !quitRequested) bye();
    };
    rl.on("line", (line) => {
      if (quitRequested) return;
      queue.push(line);
      void pump();
      rl.prompt();
    });
    rl.on("close", () => {
      closed = true;
      if (queue.length === 0 && !draining && !quitRequested) bye();
    });
    rl.prompt();
  }
}

// —— main：只做启动输出 ——
async function main(): Promise<void> {
  console.log(C.bold("\nhabor — 原生 Agent 聚合平台") + C.gray(` v${"0.2.0"}`));
  console.log(C.gray("用户只选模型；任务自动跑在对应厂商的原生 agent 里。"));
  console.log(C.gray("State 层：任务/会话绑定/对话/快照统一管理，跨 harness 切换不丢上下文。\n"));
  const available = await listAvailable();
  console.log(C.gray(`可用模型: ${available.join(", ") || "（无）"}`));
  const recent = router.listTasks().slice(0, 1);
  if (recent.length > 0) {
    console.log(C.gray(`最近任务: ${recent[0].id}（${recent[0].title}，对话 ${recent[0].conversation.length} 轮）`));
  }
  console.log(C.gray(`输入 /help 查看命令；输入 / 或 Tab 可补全。\n`));
  if (process.stdin.isTTY && !currentTaskId && !process.env.HABOR_NO_AUTOPICK) {
    ttyInput?.pause();
    const picked = await selectModelInteractive("选择模型（↑/↓ 导航 · 直接输入过滤）");
    ttyInput?.resume();
    if (picked) await selectModel(picked);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

startInput();
