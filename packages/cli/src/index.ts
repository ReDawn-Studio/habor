#!/usr/bin/env node
/**
 * cli/src/index.ts — habor：原生 Agent 聚合平台 CLI。
 *
 * 产品决策：
 *   - 用户只看到「模型」，agent/harness 是内部实现。
 *   - 任务（Task）是跨 harness 切换保持不变的持久单位。
 *
 * 界面：TTY 下为全屏 TUI（opencode/kimi 风格，DeepSeek 蓝白主题）；
 * 非 TTY（管道/脚本）下为日志式输出 + readline 输入。
 *
 * 分层：CLI → TaskRouter（Orchestrator+Router）→ Adapters（ACP/ZCode）
 */
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAdapters } from "@agent-router/adapters";
import { createRouter, listModels, adapterIdForModel, MODEL_CATALOG } from "@agent-router/router";
import { pick } from "./picker.js";
import { MdStream } from "./md.js";
import { renderEvent } from "./render.js";
import { TuiController, type Block } from "./tui/index.js";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`
};

// —— State 层：任务持久化到 ~/.habor/state.jsonl ——
const stateDir = join(homedir(), ".habor");
const stateFile = join(stateDir, "state.jsonl");
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
if (!existsSync(stateFile)) {
  const legacy = join(homedir(), ".myagent", "state.jsonl");
  if (existsSync(legacy)) {
    try {
      writeFileSync(stateFile, readFileSync(legacy, "utf8"), "utf8");
    } catch { /* 迁移失败忽略 */ }
  }
}

const { router, tasks } = createRouter(createAdapters(), { stateFile });
if (existsSync(stateFile)) {
  try {
    tasks.loadFromJSON(readFileSync(stateFile, "utf8"));
  } catch { /* 忽略 */ }
}
const cwd = process.cwd();
let permission: "ask" | "auto" = "auto";
let currentTaskId: string | null = null;
let quitRequested = false;

// —— 界面层（TTY = 全屏 TUI；非 TTY = 日志输出）——
const isTty = !!process.stdin.isTTY;
let tui: TuiController | null = null;

/** 命令/系统输出（TUI → 消息块；非 TUI → console.log） */
function out(text: string): void {
  if (tui) {
    tui.view.blocks.push({ kind: "system", text: stripAnsiForBlock(text) });
    tui.view.paint();
  } else {
    console.log(text);
  }
}
function stripAnsiForBlock(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function persist(force = false): void {
  const write = () => {
    try {
      writeFileSync(stateFile, tasks.toJSON(), "utf8");
    } catch { /* 忽略 */ }
  };
  if (force) write();
  else setTimeout(write, 400);
}

let byeOnce = false;
function bye(): void {
  if (byeOnce) return;
  byeOnce = true;
  if (process.env.HABOR_DEBUG_BLOCKS && tui) {
    try {
      writeFileSync("/tmp/habor-blocks.json", JSON.stringify(tui.view.blocks.map(b=>({kind:b.kind, text:b.text.slice(0,200), meta:b.meta})), null, 1));
    } catch { /* ignore */ }
  }
  persist(true);
  tui?.stop();
  console.log("\nbye");
  process.exit(0);
}

const HELP = `habor — 原生 Agent 聚合平台
用户只选模型；任务自动跑在对应厂商的原生 agent（harness）里。

命令:
  /model <名字>         选择模型（新任务 或 切换当前任务的执行 harness）；Tab 可补全
  /models               列出可用模型
  /tasks                列出任务（绑定链）
  /new                  结束当前任务，开始新任务
  /status               当前任务 + 会话绑定
  /permission <ask|auto> 权限模式
  /help                 帮助
  /quit                 退出
直接输入 = 「继续当前任务」（同一任务永远留在原 session 上执行）。
输入 / 或 Tab 可补全命令与模型。`;

// —— 模型选择 ——

async function listAvailable(): Promise<string[]> {
  return router.listAvailableModels();
}

function harnessForModel(model: string): string {
  const id = adapterIdForModel(model);
  return id ? id : "?";
}

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

async function selectModel(model: string): Promise<void> {
  const available = await listAvailable();
  if (!available.includes(model)) {
    out(C.red(`✗ 模型不可用: ${model}`));
    out(C.gray(`  当前可用: ${available.join(", ") || "（无）"}`));
    return;
  }
  const entry = MODEL_CATALOG.find((m) => m.model === model);
  if (!currentTaskId) {
    const task = await router.newTask({ model, cwd, permission });
    currentTaskId = task.id;
    tui?.setTask(task.id);
    tui?.setModel(model);
    out(C.green(`✓ 新任务 ${task.id} · 已连接: ${model}`) + C.gray(` → ${harnessForModel(model)}（${entry?.display ?? ""}）`));
  } else {
    const before = router.getTask(currentTaskId);
    const oldTarget = before ? before.bindings.filter((b) => !b.endedAt).at(-1) : undefined;
    await router.switchTaskModel(currentTaskId, model, { permission });
    tui?.setModel(model);
    out(C.yellow(`⇄ 切换到: ${model}`) + C.gray(`（原 ${oldTarget?.model ?? ""} 会话已关闭，上下文快照已保存）`));
  }
  persist();
}

async function handleCommand(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/help":
      out(HELP);
      return true;
    case "/models": {
      const available = await listAvailable();
      const sb: string[] = [];
      sb.push(C.bold("\n可用模型（背后自动对应原生 harness）:"));
      for (const m of listModels()) {
        const ok = available.includes(m);
        const entry = MODEL_CATALOG.find((x) => x.model === m);
        sb.push(`  ${ok ? "○" : C.dim("×")} ${C.bold(m)}${C.gray(` → ${harnessForModel(m)}`)}`);
        sb.push(C.gray(`      ${entry?.vendor} · ${entry?.display ?? ""}`));
      }
      out(sb.join("\n"));
      return true;
    }
    case "/model":
      if (!arg) {
        const available = await listAvailable();
        const sb: string[] = [C.bold("\n可用模型:")];
        available.forEach((m, i) => sb.push(`  ${i + 1}. ${m}`));
        sb.push(C.gray("用法: /model <模型名>（Tab 可补全，如 /model gl → GLM-5.3）"));
        out(sb.join("\n"));
      } else {
        const available = await listAvailable();
        const resolved = resolveModelArg(arg, available);
        if (resolved) await selectModel(resolved);
        else out(C.yellow(`「${arg}」未能唯一匹配。可用: ${available.join(", ")}`));
      }
      return true;
    case "/tasks": {
      const list = router.listTasks();
      if (list.length === 0) {
        out(C.yellow("（暂无任务，用 /model 开始一个）"));
        return true;
      }
      const sb: string[] = [C.bold("\n任务（State 层：Task / 绑定链 / 对话轮数）:")];
      for (const t of list) {
        const mark = t.id === currentTaskId ? C.green("●") : "○";
        const active = t.bindings.filter((b) => !b.endedAt).at(-1);
        sb.push(`  ${mark} ${C.bold(t.id)}  ${t.title}${t.id === currentTaskId ? C.green("  ← 当前") : ""}`);
        sb.push(C.gray(`      对话 ${t.conversation.length} 轮 · 快照 ${t.contextSnapshots.length}`));
        for (const b of t.bindings) {
          sb.push(C.gray(`        ${b.model} @ ${b.adapterId} (${b.sessionId}) [${b.reason}]${b.endedAt ? " 已结束" : " 活跃"}`));
        }
      }
      out(sb.join("\n"));
      return true;
    }
    case "/new": {
      if (currentTaskId) {
        const t = router.getTask(currentTaskId);
        if (t) {
          await router.finishTask(currentTaskId, "done");
          out(C.green(`✓ 任务 ${currentTaskId} 已结束`));
        }
        currentTaskId = null;
        tui?.setTask(null);
        tui?.setModel(null);
      }
      out(C.gray("新任务：用 /model 选择模型开始。"));
      persist();
      return true;
    }
    case "/status": {
      if (!currentTaskId) {
        out(C.yellow("尚无当前任务。用 /model 选择一个模型。"));
        return true;
      }
      const { task, target } = router.status(currentTaskId);
      const sb: string[] = [C.bold(`任务: ${task.id}`) + C.gray(`  ${task.title}`)];
      sb.push(`  状态: ${task.status} · 对话 ${task.conversation.length} 轮`);
      if (target) sb.push(`  当前绑定: ${C.bold(target.model)} → harness ${C.cyan(target.adapterId)} (session ${target.sessionId})`);
      sb.push(`  权限: ${permission}`);
      out(sb.join("\n"));
      return true;
    }
    case "/permission":
      if (arg === "ask" || arg === "auto") {
        permission = arg;
        out(C.green(`✓ 权限模式: ${permission}`));
      } else {
        out(C.yellow("用法: /permission ask|auto"));
      }
      return true;
    case "/quit":
    case "/exit":
      return false;
    default:
      out(C.yellow(`未知命令: ${cmd}（/help 查看帮助）`));
      return true;
  }
}

// —— 统一输入分发 ——

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
    out(C.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  }
}

// —— 事件流 → 界面（TTY: Block 追加；非 TTY: 流式 markdown） ——

async function runPrompt(text: string): Promise<void> {
  if (!currentTaskId) {
    out(C.yellow("先用 /model 选择一个模型开始任务。"));
    return;
  }
  tui?.beginTurn();

  if (tui) {
    // TUI 模式：user 块 + 事件转 Block
    tui.view.blocks.push({ kind: "user", text });
    let assistantBuf = "";
    let thinkingBuf = "";
    let toolStatus: "running" | "done" = "running";
    try {
      for await (const ev of router.continueTask(currentTaskId, text)) {
        if (ev.type === "message") {
          assistantBuf += ev.delta ?? ev.text ?? "";
          tui.append({ kind: "assistant", text: assistantBuf, meta: { delta: ev.delta ?? ev.text ?? "" } });
        } else if (ev.type === "thinking") {
          thinkingBuf += ev.thinking ?? "";
          tui.append({ kind: "thinking", text: thinkingBuf, meta: { delta: ev.thinking ?? "" } });
        } else if (ev.type === "tool_call") {
          tui.append({ kind: "tool", text: "", meta: { name: ev.tool?.name, status: "running" } });
        } else if (ev.type === "tool_result") {
          // 更新最后一个 tool 块（找到 blocks 中最后一个未完成的 tool）
          const lastTool = [...tui.view.blocks].reverse().find((b) => b.kind === "tool" && b.meta?.status !== "done");
          if (lastTool) {
            lastTool.text = (ev.toolResult?.output ?? "").slice(0, 400);
            lastTool.meta = { ...lastTool.meta, status: "done" };
            tui.view.paint();
          }
        } else if (ev.type === "usage") {
          const u = ev.usage;
          const raw = (u?.raw ?? {}) as { used?: number; size?: number };
          const parts = [
            u?.inputTokens != null ? `in ${u.inputTokens}` : "",
            u?.outputTokens != null ? `out ${u.outputTokens}` : "",
            u?.cachedTokens != null ? `cached ${u.cachedTokens}` : ""
          ].filter(Boolean);
          const used = raw.used != null ? `used ${raw.used}/${raw.size}` : "";
          tui.append({ kind: "usage", text: `usage: ${parts.join(" / ")}${parts.length && used ? " · " : ""}${used}` });
        } else if (ev.type === "error") {
          tui.view.blocks.push({ kind: "system", text: C.red(`✗ ${ev.error?.message ?? "错误"}`) });
          tui.view.paint();
        } else if (ev.type === "done") {
          break;
        }
      }
    } catch (err) {
      tui.view.blocks.push({ kind: "system", text: C.red(`✗ ${err instanceof Error ? err.message : String(err)}`) });
      tui.view.paint();
    }
    tui.endTurn();
    persist();
    return;
  }

  // —— 非 TTY：流式 markdown 渲染（日志式） ——
  const md = new MdStream();
  const INDENT = "  ";
  let inAssistant = false;
  let inThinking = false;
  const endThinking = () => {
    if (inThinking) {
      process.stdout.write("\n");
      inThinking = false;
    }
  };
  const writeMd = (o: string) => {
    if (!o) return;
    const lines = o.split("\n");
    process.stdout.write(lines[0]);
    for (let i = 1; i < lines.length; i++) process.stdout.write("\n" + (lines[i] ? INDENT + lines[i] : ""));
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
          process.stdout.write(C.cyan("● "));
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
        endThinking();
        flushText();
        if (inAssistant) process.stdout.write("\n");
        inAssistant = false;
        const r = renderEvent(ev);
        if (r) console.log(r);
      }
    }
  } catch (err) {
    endThinking();
    console.log(C.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  }
}

// —— Tab 补全 ——

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

// —— 启动 ——

async function main(): Promise<void> {
  const available = await listAvailable();

  if (isTty) {
    // 全屏 TUI
    tui = new TuiController({
      version: "0.2.0",
      onInput: (line) => void dispatch(line),
      onComplete: completeLine,
      onInterrupt: () => bye()
    });
    tui.start();
    tui.view.blocks.push({ kind: "system", text: `◈ habor v0.2.0 — 原生 Agent 聚合平台` });
    tui.view.blocks.push({ kind: "system", text: `可用模型: ${available.join(", ") || "（无）"} · 输入 / 或 Tab 补全` });
    if (!currentTaskId) {
      tui.view.blocks.push({ kind: "system", text: C.yellow(`提示: /model + Tab 选择模型（如 /model gl → GLM-5.3）`) });
    }
    tui.view.paint();
    return;
  }

  // 非 TTY（管道/脚本）：日志输出 + readline
  console.log(C.bold(`\nhabor — 原生 Agent 聚合平台 v0.2.0`));
  console.log(C.gray(`可用模型: ${available.join(", ") || "（无）"}`));
  console.log(C.gray(`输入 /help 查看命令。\n`));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
