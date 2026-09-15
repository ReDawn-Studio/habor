#!/usr/bin/env node
/**
 * cli/src/index.ts — habor：原生 Agent 聚合平台 CLI。
 *
 * 产品决策：
 *   - 用户只看到「模型」，agent/harness 是内部实现。
 *   - 任务（Task）是跨 harness 切换保持不变的持久单位。
 *
 * 界面：TTY 下为全屏 TUI（对话区、可编辑草稿、命令菜单）；
 * 非 TTY（管道/脚本）下为日志式输出 + readline 输入。
 *
 * 分层：CLI → TaskRouter（Orchestrator+Router）→ Adapters（ACP/ZCode）
 */
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAdapters } from "@agent-router/adapters";
import { createRouter } from "@agent-router/router";
import { MdStream } from "./md.js";
import { renderEvent } from "./render.js";
import { TuiController } from "./tui/index.js";
import { TurnEvents } from "./tui/events.js";
import { ProviderStore } from "./providers.js";
import { AGENT_ADAPTERS, AGENT_NAMES, reasoningLabel, configuredReasoning, type ReasoningCapabilities, type AgentKind, type ProviderProfile } from "@agent-router/core";
import { ReasoningPreferences } from "./reasoning-preferences.js";
import { AGENT_SETUP, EXTERNAL_AGENT_TARGETS, missingAgentMessage, openAgentInstallPage } from "./agent-setup.js";
import { AgentInstaller } from "./agent-installer.js";
import { nativeAuthStatus, nativeLoginCommand, type AuthMethod, type AuthStatus } from "./agent-auth.js";
import { runAgentCommand } from "./agent-process.js";
import { AGENT_RUNTIMES, agentExecutable, executableOnPath } from "@agent-router/core";
import { WorkspaceTrust } from "./workspace-trust.js";
import { listOfficialHistories, type OfficialHistory } from "./official-history.js";

const VERSION = "0.5.8";
if (process.argv.includes("--version")) { console.log(`habor v${VERSION}`); process.exit(0); }

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
const stateDir = process.env.HABOR_STATE_DIR ?? join(homedir(), ".habor");
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

const providers = new ProviderStore(stateDir);
const workspaceTrust = new WorkspaceTrust(stateDir);
const agentInstaller = new AgentInstaller(stateDir);
const lifecycleShutdown = new AbortController();
let lifecycleWork: Promise<unknown> | undefined;
async function trackLifecycle<T>(action: () => Promise<T>): Promise<T> {
  if (lifecycleWork) throw new Error("已有安装或登录操作在进行");
  const work = action(); lifecycleWork = work;
  try { return await work; } finally { if (lifecycleWork === work) lifecycleWork = undefined; }
}
const reasoningPreferences = new ReasoningPreferences(stateDir);
const { router, tasks, registry } = createRouter(createAdapters(), { stateFile });
registry.configure(providers.entries(), entry => providers.connection(entry));
if (existsSync(stateFile)) {
  try {
    tasks.loadFromJSON(readFileSync(stateFile, "utf8"));
  } catch { /* 忽略 */ }
}
const cwd = process.cwd();
let permission: "ask" | "auto" = "auto";
let currentTaskId: string | null = null;
let conversationMode: "fresh" | "resumed" = "fresh";
let quitRequested = false;

// —— 界面层（TTY = 全屏 TUI；非 TTY = 日志输出）——
const isTty = !!process.stdin.isTTY && !!process.stdout.isTTY && process.env.TERM !== "dumb";
let cancelRequested = false;
let tui: TuiController | null = null;

/** 命令/系统输出（TUI → 消息块；非 TUI → console.log） */
function out(text: string): void {
  if (tui) {
    tui.append({ kind: "system", text: stripAnsiForBlock(text) });
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
async function bye(): Promise<void> {
  if (byeOnce) return;
  byeOnce = true;
  if (process.env.HABOR_DEBUG_BLOCKS && tui) {
    try {
      writeFileSync("/tmp/habor-blocks.json", JSON.stringify(tui.view.blocks.map(b=>({kind:b.kind, text:b.text.slice(0,200), meta:b.meta})), null, 1));
    } catch { /* ignore */ }
  }
  persist(true);
  tui?.stop();
  lifecycleShutdown.abort();
  await lifecycleWork?.catch(() => {});
  await router.close();
  console.log("\nbye");
  process.exit(0);
}

function tasksInCurrentWorkspace() {
  const current = workspaceTrust.canonical(cwd);
  return tasks.listTasks().filter(task => workspaceTrust.canonical(task.cwd) === current);
}

async function resumeTask(taskId: string): Promise<void> {
  if (!workspaceTrust.isTrusted(cwd)) throw new Error("请先运行 /trust 确认当前工作区");
  const candidates = tasksInCurrentWorkspace();
  const task = candidates.find(item => item.id === taskId);
  if (!task) throw new Error("找不到当前工作区中的任务；任务不会跨目录显示或恢复");
  const resumed = router.resumeTask(task.id);
  const target = router.status(resumed.id).target;
  if (!target || !registry.entry(target.model)) throw new Error("任务绑定的模型配置已不存在，请重新选择模型");
  const available = await listAvailable();
  if (!available.includes(target.model)) throw new Error(`任务需要的 Agent 当前不可用：${target.model}`);
  currentTaskId = resumed.id;
  conversationMode = "resumed";
  tui?.setTask(resumed.id); tui?.setModel(target.model); tui?.setConversation(resumed.conversation);
  tui?.view && (tui.view.reasoningEffort = reasoningPreferences.get(registry.entry(target.model)!));
  out(C.green(`✓ 已恢复 ${resumed.id} · ${target.model} · 当前工作区上下文已加载`));
  persist();
}

async function resumeOfficialHistory(history: OfficialHistory): Promise<void> {
  if (!workspaceTrust.isTrusted(cwd)) throw new Error("请先运行 /trust 确认当前工作区");
  const available = await listAvailable();
  const currentModel = currentTaskId ? router.status(currentTaskId).target?.model : undefined;
  const preferredModel = providers.preferredModel(registry.listModels())?.model;
  const model = [currentModel, preferredModel, ...available].find(candidate => candidate && available.includes(candidate));
  if (!model || !available.includes(model)) throw new Error("请先选择一个当前可用模型，用它继续官方历史会话");
  const task = await router.newTask({ model, cwd, title: `[${history.source}] ${history.title}`, permission, reasoningEffort: reasoningPreferences.get(registry.entry(model)!) });
  const binding = task.bindings.at(-1);
  if (binding) binding.reason = "switch";
  for (const turn of history.turns) tasks.appendTurn(task, { role: turn.role, text: turn.text, model: `${history.source} history`, adapterId: history.source.toLowerCase().replace(/\s+/g, "-") });
  currentTaskId = task.id; conversationMode = "resumed";
  tui?.setTask(task.id); tui?.setModel(model); tui?.setConversation(history.turns);
  out(C.green(`✓ 已导入 ${history.source} 历史会话 · ${history.title} · 当前使用 ${model}`));
  persist();
}

async function resumeAnyTask(id: string): Promise<void> {
  const official = listOfficialHistories(cwd).find(history => history.id === id);
  if (official) return resumeOfficialHistory(official);
  return resumeTask(id);
}

const HELP = `habor — 原生 Agent 聚合平台
用户只选模型；任务自动跑在对应厂商的原生 agent（harness）里。

命令:
  /model                打开模型选择面板，↑↓ 选择、Enter 确认
  /models               打开模型选择面板（管道模式列出模型）
  /providers            本地客户端 / 官方 API / 自定义提供商配置
  /agents               管理 Agent：自动安装、原生登录或 API Key
  /login                管理当前 Agent 的认证
  /trust                查看并确认当前工作区信任
  /refresh              重新检测已安装的 Agent
  /effort [档位]        当前模型的思考强度；无参数时打开选择器
  /tasks                列出当前工作区任务（绑定链）
  /resume [任务 ID]     恢复当前工作区的历史任务
  /new                  结束当前任务，开始新任务
  /status               当前任务 + 会话绑定
  /permission <ask|auto> 权限模式
  /clear                清空屏幕（保留任务和对话）
  /help                 帮助
  /quit                 退出
普通输入默认开始新的会话；使用 /resume 恢复历史任务后，输入才会继续原 session。
输入 / 打开命令菜单，↑↓ 选择，Tab 补全，Enter 确认。

快捷键（交互终端）：
  F2                    选择或切换模型（保留当前草稿）
  F3                    添加或编辑 API 来源（Key 输入隐藏）
  F4                    当前模型的思考强度；按模型与来源分别保存
  F5                    Agent 安装与认证；模型菜单内管理选中的 Agent
  ←→ / Home / End       移动输入光标
  Alt+Enter / Ctrl+J     换行（支持的终端也可用 Shift+Enter）
  ↑↓                    历史输入 / 多行移动
  PgUp / PgDn             浏览对话；Esc 回到底部
  Ctrl+O                展开或折叠思考与工具输出
  Ctrl+Y                复制最近一段回复
  Ctrl+L                清空屏幕
  Esc / Ctrl+C          停止当前回复，保留会话界面
  Ctrl+C                清空草稿；空草稿下连按两次退出
运行时可以继续编辑草稿，结束后按 Enter 发送。
默认由终端处理鼠标拖选和复制；HABOR_MOUSE_SCROLL=1 时 habor 接管滚轮，使用终端支持的 Shift / Option 拖选。`;

// —— 模型选择 ——

let availableModels: string[] | null = null;
let cachedReasoning: { model: string; capabilities: ReasoningCapabilities } | undefined;
async function listAvailable(): Promise<string[]> {
  return availableModels ?? router.listAvailableModels();
}

function harnessForModel(model: string): string {
  const id = registry.entry(model)?.adapterId;
  return id ? id : "?";
}

async function refreshConnections(): Promise<void> {
  cachedReasoning = undefined;
  registry.configure(providers.entries(), entry => providers.connection(entry));
  const availability = await registry.availableAdapters();
  availableModels = registry.listModels().filter(entry => availability[entry.adapterId]).map(entry => entry.model);
  if (tui) {
    tui.view.providers = providers.list();
    tui.view.reasoningByModel = Object.fromEntries(registry.listModels().map(entry => [entry.model, reasoningPreferences.get(entry)]));
    tui.view.modelInfo = Object.fromEntries(registry.listModels().map(entry => {
      const agent = (Object.keys(AGENT_ADAPTERS) as AgentKind[]).find(kind => AGENT_ADAPTERS[kind] === entry.adapterId);
      return [entry.model, { source: entry.sourceKind ?? "local", agent: agent ? AGENT_NAMES[agent] : entry.adapterId, modelId: entry.modelId ?? entry.model, adapterId: entry.adapterId, installed: !!availability[entry.adapterId] }];
    }));
    tui.view.externalAgentModels = EXTERNAL_AGENT_TARGETS.map(entry => entry.model);
    for (const entry of EXTERNAL_AGENT_TARGETS) tui.view.modelInfo[entry.model] = { source: "local", agent: AGENT_SETUP[entry.adapterId].name, modelId: entry.modelId, adapterId: entry.adapterId, installed: !!executableOnPath(agentExecutable(entry.adapterId)), nativeTerminalOnly: true };
    tui.view.setModels(registry.listModels().map(entry => entry.model));
  }
}

async function currentReasoning(): Promise<ReasoningCapabilities> {
  if (!currentTaskId) throw new Error("请先按 F2 选择模型");
  const model = router.status(currentTaskId).target?.model;
  if (!model) throw new Error("当前任务没有模型");
  if (cachedReasoning?.model === model) return cachedReasoning.capabilities;
  const capabilities = await router.reasoningCapabilities(currentTaskId);
  cachedReasoning = { model, capabilities };
  return capabilities;
}

async function setCurrentEffort(effort: string | undefined): Promise<void> {
  if (!currentTaskId) throw new Error("请先选择模型");
  const model = router.status(currentTaskId).target?.model;
  if (!model) throw new Error("当前任务没有模型");
  const previous = router.getReasoningEffort(currentTaskId);
  await router.setReasoningEffort(currentTaskId, effort);
  try { reasoningPreferences.set(registry.entry(model)!, effort); }
  catch (error) { await router.setReasoningEffort(currentTaskId, previous); throw error; }
  if (tui) { tui.view.reasoningEffort = effort; tui.view.reasoningByModel[model] = effort; }
  out(`✓ ${model} · 思考强度：${reasoningLabel(effort)}${effort ? ` (${effort})` : ""} · 下一条消息生效`);
  persist();
}

async function saveProvider(profile: ProviderProfile, key?: string, useModelId?: string): Promise<void | string> {
  if (useModelId && !profile.models.some(model => model.id === useModelId)) throw new Error("请选择此来源中的模型");
  const oldEntry = currentTaskId ? registry.entry(router.status(currentTaskId).target?.model ?? "") : undefined;
  providers.save(profile, key);
  await refreshConnections();
  const next = registry.listModels().find(entry => entry.providerId === profile.id && entry.modelId === (useModelId ?? oldEntry?.modelId));
  // Updating a Key or URL invalidates the already running native process, even when the model label is unchanged.
  if (currentTaskId && oldEntry?.providerId === profile.id) {
    await router.refreshSession(currentTaskId);
  }
  out(`✓ 已保存 ${profile.name} · API Key 独立保存`);
  if (useModelId || oldEntry?.providerId === profile.id) {
    if (next) {
      if (!availableModels!.includes(next.model)) {
        out(`连接配置已保存 · 待安装 ${AGENT_SETUP[next.adapterId]?.name ?? next.adapterId} · 当前任务保留`);
        return next.model;
      }
      try { await selectModel(next.model); }
      catch (error) { throw new Error(`配置已保存，连接未切换：${error instanceof Error ? error.message : String(error)}`); }
    } else {
      // A removed model has no valid route; retain the task so choosing another source can carry over its context.
      tui?.setModel(null);
      out("当前模型已从此来源移除，请按 F2 选择新模型；任务记录已保留。");
    }
  } else out(`当前连接：${oldEntry?.model ?? "尚未选择"} · 按 F2 切换`);
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
  if (!workspaceTrust.isTrusted(cwd)) throw new Error("当前工作区尚未信任，请在交互终端选择“是，继续”，或运行 /trust");
  const external = EXTERNAL_AGENT_TARGETS.find(entry => entry.model === model);
  if (external) {
    if (!executableOnPath(agentExecutable(external.adapterId))) throw new Error(missingAgentMessage(external.adapterId));
    await loginAgent(model, "native");
    out(`已退出 ${AGENT_SETUP[external.adapterId].name} 独立会话，habor 原任务与草稿保留。`);
    return;
  }
  // Re-probe on selection: installation may have completed while the setup panel was open.
  await refreshConnections();
  const available = await listAvailable();
  if (!available.includes(model)) {
    const entry = registry.entry(model);
    throw new Error(entry ? missingAgentMessage(entry.adapterId) : `未知模型：${model}`);
  }
  const effort = reasoningPreferences.get(registry.entry(model)!);
  if (!currentTaskId) {
    const task = await router.newTask({ model, cwd, permission, reasoningEffort: effort });
    currentTaskId = task.id;
    conversationMode = "fresh";
    tui?.setTask(task.id);
    tui?.setModel(model);
    out(C.green(`✓ 已选择 ${model}，可以开始对话了。`));
  } else {
    await router.switchTaskModel(currentTaskId, model, { permission, reasoningEffort: effort });
    tui?.setModel(model);
    out(C.green(`✓ 已切换到 ${model} · 当前任务的上下文已保留`));
  }
  cachedReasoning = undefined;
  providers.rememberModel(registry.entry(model)!);
  if (tui) { tui.view.reasoningEffort = effort; tui.view.paint(); }
  persist();
}

async function installAgent(model: string, onOutput: (line: string) => void, signal: AbortSignal): Promise<string> {
  const entry = registry.entry(model) ?? EXTERNAL_AGENT_TARGETS.find(entry => entry.model === model);
  if (!entry) throw new Error("模型不存在");
  return trackLifecycle(async () => {
    const version = await agentInstaller.install(entry.adapterId, { signal: AbortSignal.any([signal, lifecycleShutdown.signal]), onOutput });
    await refreshConnections();
    const override = AGENT_RUNTIMES[entry.adapterId]?.override;
    if (override && process.env[override]) throw new Error(`已安装 ${version}，但 ${override} 指定的客户端仍优先。请调整该变量后重启 habor，或继续使用指定客户端。`);
    // A live transport continues with its old binary until the next message.
    if (currentTaskId && registry.entry(router.status(currentTaskId).target?.model ?? "")?.adapterId === entry.adapterId) await router.refreshSession(currentTaskId);
    return version;
  });
}

async function loginAgent(model: string, method: AuthMethod): Promise<AuthStatus> {
  const entry = registry.entry(model) ?? EXTERNAL_AGENT_TARGETS.find(entry => entry.model === model);
  if (!entry || !tui) throw new Error("请在交互终端中选择 Agent 登录");
  const command = nativeLoginCommand(entry.adapterId, method, cwd);
  return trackLifecycle(async () => {
    const result = await tui!.withNativeTerminal(async () => {
      const independent = EXTERNAL_AGENT_TARGETS.some(target => target.adapterId === entry.adapterId);
      console.log(independent
        ? `\n进入 ${AGENT_SETUP[entry.adapterId].name} 原生终端。使用 /auth 配置、/model 选型号，或开始独立对话；退出后返回 habor。原任务文本和草稿不会自动发送。\n`
        : `\n正在进入 ${AGENT_SETUP[entry.adapterId]?.name ?? entry.adapterId} 原生认证。完成授权后返回 habor；Ctrl+C 可结束。\n`);
      return runAgentCommand(command, { inherit: true, signal: lifecycleShutdown.signal, timeoutMs: 15 * 60 * 1000 });
    });
    await refreshConnections();
    if (currentTaskId && registry.entry(router.status(currentTaskId).target?.model ?? "")?.adapterId === entry.adapterId) await router.refreshSession(currentTaskId);
    if (method !== "native" && result.code !== 0) throw new Error("登录未完成或已取消，现有任务和草稿已保留");
    if (method === "native" && result.code !== 0 && result.code !== 130) throw new Error("原生配置程序启动失败，请检查安装状态或端口占用后重试");
    const status = await nativeAuthStatus(entry.adapterId, cwd);
    if (status.state !== "unknown") return status;
    return { state: "unknown", text: method === "native" ? "原生配置入口已打开 / 关闭；完成配置后选择使用" : "原生登录流程已完成；账号额度与模型权限在连接时验证" };
  });
}

async function handleCommand(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/agents":
    case "/login":
      if (tui) { if (cmd === "/login") tui.view.openLogin(); else tui.view.openAgents(); }
      else out("请在交互终端运行 habor，按 F5 管理 Agent 的安装与认证。");
      return true;
    case "/trust":
      if (tui) tui.view.openWorkspaceTrust();
      else out(workspaceTrust.isTrusted(cwd) ? "当前工作区已信任。" : "非交互终端无法确认工作区信任，请在 TTY 中运行 habor。");
      return true;
    case "/effort": {
      if (!arg && tui) { void tui.view.openReasoning(); return true; }
      const capabilities = await currentReasoning();
      if (!arg) out(`思考强度：default（原生默认）${capabilities.levels.map(level => ` · ${level.id}（${level.label}）`).join("")}`);
      else {
        const value = ["default", "auto", "默认", "原生默认"].includes(arg.toLowerCase()) ? undefined : capabilities.levels.find(level => level.id === arg.toLowerCase() || level.label === arg)?.id ?? arg;
        await setCurrentEffort(value);
      }
      return true;
    }
    case "/providers":
      if (tui) tui.view.openProviders();
      else out("请在交互终端运行 habor，按 F3 配置提供商；不要将 API Key 写入命令行。");
      return true;
    case "/refresh":
      await refreshConnections();
      if (tui) tui.view.openModels();
      else out(`已重新检测 · ${availableModels!.length} 个模型检测到客户端；/models 查看安装状态`);
      return true;
    case "/help":
      out(HELP);
      return true;
    case "/models": {
      await refreshConnections();
      if (tui) { tui.view.openModels(); return true; }
      const available = await listAvailable();
      const sb: string[] = [];
      sb.push(C.bold("\n模型与客户端安装状态（认证在连接时验证）:"));
      for (const { model: m } of registry.listModels()) {
        const ok = available.includes(m);
        const entry = registry.entry(m);
        sb.push(`  ${ok ? "○" : C.dim("×")} ${C.bold(m)}${C.gray(` → ${harnessForModel(m)}`)}`);
        sb.push(C.gray(`      ${entry?.vendor} · ${entry?.display ?? ""}`));
        if (!ok && entry) sb.push(C.yellow(`      ${missingAgentMessage(entry.adapterId)}`));
      }
      out(sb.join("\n"));
      return true;
    }
    case "/model":
      if (!arg) {
        if (tui) { tui.view.openModels(); return true; }
        const available = await listAvailable();
        const sb: string[] = [C.bold("\n可用模型:")];
        available.forEach((m, i) => sb.push(`  ${i + 1}. ${m}`));
        sb.push(C.gray("用法: /model <模型名>（Tab 可补全，如 /model gl → GLM-5.3）"));
        out(sb.join("\n"));
      } else {
        const models = registry.listModels().map(entry => entry.model);
        const resolved = resolveModelArg(arg, models);
        if (resolved) {
          // 首次进入未信任目录时先确认信任，确认后沿用同一个待选模型。
          if (tui && !workspaceTrust.isTrusted(cwd)) tui.view.openWorkspaceTrust(resolved);
          else await selectModel(resolved);
        } else out(C.yellow(`「${arg}」未能唯一匹配。请用 /models 查看模型与安装状态。`));
      }
      return true;
    case "/clear":
      if (tui) tui.view.clearMessages();
      return true;
    case "/resume": {
      const list = tasksInCurrentWorkspace();
      const official = listOfficialHistories(cwd);
      if (!arg) {
        if (tui) { tui.view.openResume([...list.slice(0, 12).map(task => ({ id: task.id, title: task.title, model: task.bindings.at(-1)?.model ?? "未选择模型", messages: task.conversation.length, source: "habor" })), ...official.slice(0, 12).map(history => ({ id: history.id, title: history.title, model: history.model ?? "官方历史模型", messages: history.turns.length, source: history.source }))]); }
        else if (!list.length && !official.length) out(C.yellow("当前工作区暂无历史任务。"));
        else { const lines = [C.bold("当前工作区历史任务（使用 /resume <任务 ID> 恢复）:")]; [...list.slice(0, 12).map(task => `[habor] ${task.id}  ${task.title} · ${task.conversation.length} 条消息`), ...official.slice(0, 12).map(history => `[${history.source}] ${history.id}  ${history.title} · ${history.turns.length} 条消息`)].forEach(line => lines.push(`  ${line}`)); out(lines.join("\n")); }
        return true;
      }
      const all = [...list.map(task => ({ id: task.id, official: false })), ...official.map(history => ({ id: history.id, official: true }))];
      const target = /^\d+$/.test(arg) ? all[Number(arg) - 1] : all.find(item => item.id === arg) ?? all.find(item => item.id.startsWith(arg));
      if (!target) out(C.yellow("找不到当前工作区中的任务；其他目录的任务不会显示。"));
      else await resumeAnyTask(target.id);
      return true;
    }
    case "/tasks": {
      const list = tasksInCurrentWorkspace();
      if (list.length === 0) {
        out(C.yellow("（暂无任务，用 /model 开始一个）"));
        return true;
      }
      const sb: string[] = [C.bold(`最近任务（共 ${list.length} 个）:`)];
      for (const t of list.slice(0, 8)) {
        const mark = t.id === currentTaskId ? C.green("●") : "○";
        sb.push(`  ${mark} ${C.bold(t.id)}  ${t.title}${t.id === currentTaskId ? C.green("  ← 当前") : ""}`);
        const active = t.bindings.at(-1);
        sb.push(C.gray(`      ${active?.model ?? "未选择模型"} · ${t.conversation.length} 条消息 · ${t.status}`));
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
        conversationMode = "fresh";
        tui?.setTask(null);
        tui?.setModel(null);
        if (tui) tui.view.reasoningEffort = undefined;
        cachedReasoning = undefined;
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
      if (target) {
        const entry = registry.entry(target.model);
        sb.push(`  模型: ${target.model} · 模型 ID: ${entry?.modelId ?? target.model}`);
        sb.push(`  来源: ${entry?.sourceKind === "local" ? "本地客户端登录和配置" : entry?.vendor ?? "未知"} → ${target.adapterId}`);
      }
      sb.push(`  权限: ${permission}`);
      sb.push(`  思考强度: ${reasoningLabel(router.getReasoningEffort(currentTaskId))}（仅此模型与来源）`);
      out(sb.join("\n"));
      return true;
    }
    case "/permission":
      if (arg === "ask" || arg === "auto") {
        permission = arg;
        if (tui) tui.view.permission = permission;
        out(C.green(`✓ 权限模式: ${permission}（用于后续新建或切换的会话）`));
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
        await bye();
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
  if (!currentTaskId || !registry.entry(router.status(currentTaskId).target?.model ?? "")) {
    out(C.yellow("先用 /model 选择一个模型开始任务。"));
    tui?.view.setInput(text);
    return;
  }
  if (conversationMode === "fresh") {
    const previous = router.status(currentTaskId);
    const model = previous.target?.model;
    if (previous.task.conversation.length > 0 && model) {
      currentTaskId = null;
      tui?.setTask(null); tui?.setModel(null); tui?.view.clearMessages();
      await selectModel(model);
      out("✓ 已开始新的会话；之前的任务可用 /resume 恢复");
    }
  }
  const activeTaskId = currentTaskId;
  if (!activeTaskId) throw new Error("没有可用的当前任务");
  tui?.beginTurn();

  if (tui) {
    cancelRequested = false;
    tui.append({ kind: "user", text });
    const events = new TurnEvents(tui.view);
    try {
      for await (const ev of router.continueTask(activeTaskId, text)) {
        if (cancelRequested) break;
        events.accept(ev);
        if (ev.type === "done") break;
      }
    } catch (err) {
      if (!cancelRequested) {
        events.failed = true;
        tui.append({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      events.finish(cancelRequested);
      tui.endTurn();
      if (cancelRequested) {
        tui.append({ kind: "system", text: "已停止回复。可以修改草稿后继续。" });
        tui.setStatusText("已停止");
      } else if (events.failed) tui.setStatusText("回复出错 · 可重试");
      persist();
    }
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
    for await (const ev of router.continueTask(activeTaskId, text)) {
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

const COMMANDS = ["model", "models", "providers", "agents", "login", "trust", "refresh", "effort", "new", "status", "tasks", "resume", "permission", "clear", "help", "quit", "exit"];
function completeLine(line: string): string[] {
  if (line.startsWith("/effort ")) {
    const model = currentTaskId ? router.status(currentTaskId).target?.model : undefined;
    const entry = model ? registry.entry(model) : undefined;
    const capabilities = cachedReasoning?.model === model ? cachedReasoning?.capabilities : entry ? configuredReasoning({ model: entry.model, modelId: entry.modelId, cwd, reasoningLevels: entry.reasoningLevels }, entry.adapterId) : undefined;
    const q = line.slice(8).trim().toLowerCase();
    return ["default", ...(capabilities?.levels.map(level => level.id) ?? [])].filter(value => value.startsWith(q)).map(value => `/effort ${value}`);
  }
  if (line.startsWith("/model ")) {
    const q = line.slice(7).trim().toLowerCase();
    return registry.listModels().map(entry => entry.model)
      .filter((m) => m.toLowerCase().includes(q))
      .map((m) => `/model ${m}`);
  }
  if (line.startsWith("/permission ")) {
    const q = line.slice(12).trim();
    return ["ask", "auto"].filter(mode => mode.startsWith(q)).map(mode => `/permission ${mode}`);
  }
  if (line.startsWith("/")) {
    const q = line.slice(1).toLowerCase();
    return COMMANDS.filter((c) => c.startsWith(q)).map((c) => `/${c}`);
  }
  return [];
}

// —— 启动 ——

async function main(): Promise<void> {
  if (isTty) {
    tui = new TuiController({
      version: VERSION,
      cwd,
      onInput: dispatch,
      onComplete: completeLine,
      onSelectModel: selectModel,
      onSaveProvider: saveProvider,
      onInstallAgent: installAgent,
      onLoginAgent: loginAgent,
      onInspectAgentAuth: async model => nativeAuthStatus((registry.entry(model) ?? EXTERNAL_AGENT_TARGETS.find(entry => entry.model === model))?.adapterId ?? "", cwd),
      onCheckWorkspaceTrust: () => workspaceTrust.isTrusted(cwd),
      onTrustWorkspace: async () => { workspaceTrust.trust(cwd); out("✓ 已信任当前工作区"); },
      onWorkspaceTrustDenied: () => { void bye(); },
      onResumeTask: resumeAnyTask,
      onOpenAgentDocs: async model => {
        const entry = registry.entry(model) ?? EXTERNAL_AGENT_TARGETS.find(entry => entry.model === model);
        if (!entry) throw new Error("模型配置已变更，请重新选择");
        await openAgentInstallPage(entry.adapterId);
      },
      onGetReasoning: currentReasoning,
      onSetReasoning: setCurrentEffort,
      onInterrupt: () => {
        if (!currentTaskId || cancelRequested) return;
        cancelRequested = true;
        tui?.setStatusText("正在停止");
        void router.cancelTask(currentTaskId).catch(err => out(`停止失败：${String(err)}`));
      },
      onExit: bye
    });
    tui.start();
    process.once("exit", () => tui?.stop());
    process.once("SIGTERM", bye);
    process.once("SIGHUP", bye);
    await refreshConnections();
    const preferred = providers.preferredModel(registry.listModels().filter(entry => availableModels!.includes(entry.model)));
    // 未信任目录不自动恢复连接：信任确认在用户选择模型时弹出。
    if (workspaceTrust.isTrusted(cwd) && preferred && !tui.view.input && !tui.view.blocks.length && !tui.view.providerPanel && !tui.view.modelPicker && !tui.view.agentSetupPanel) {
      try { await selectModel(preferred.model); }
      catch (error) { out(`恢复上次连接失败：${error instanceof Error ? error.message : String(error)} · 按 F2 重新选择`); }
    }
    if (!availableModels!.length) out("未检测到 Agent。选择模型并回车查看安装步骤；F3 可先保存 API 配置，安装后继续使用。");
    return;
  }
  const available = await listAvailable();

  // 非 TTY（管道/脚本）：日志输出 + readline
  console.log(C.bold(`\nhabor — 原生 Agent 聚合平台 v${VERSION}`));
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
  tui?.stop();
  console.error(err);
  process.exit(1);
});
