/**
 * @agent-router/router — 路由层（独立子项目）。
 *
 * 职责（对齐架构图）：
 *   Router（select Agent）：
 *     - MODEL_CATALOG：用户可见模型 → 原生 harness 的确定性映射
 *     - Registry：adapter 注册 + 模型可用性
 *     - TaskRouter：Task/Session 亲和性路由 + 任务简报注入（State 层配合）
 *   State 层：
 *     - TaskStore：Task / 绑定链 / 对话 / 快照 / 产物 / 检查点
 *
 * 依赖：仅 @agent-router/core（契约层：types）。具体 harness 由调用方注入。
 */
export * from "./registry.js";
export * from "./state.js";
export * from "./router.js";
export { MODEL_CATALOG, listModels, adapterIdForModel } from "./registry.js";
import type { Adapter } from "@agent-router/core";
import { Registry } from "./registry.js";
import { TaskStore } from "./state.js";
import { TaskRouter } from "./router.js";

/** 便捷组装：注入 adapters，返回带完整注册的 TaskRouter。 */
export function createRouter(adapters: Adapter[], opts: { stateFile?: string } = {}): {
  router: TaskRouter;
  registry: Registry;
  tasks: TaskStore;
} {
  const registry = new Registry();
  for (const a of adapters) registry.register(a);
  const tasks = new TaskStore();
  const router = new TaskRouter(registry, tasks, { stateFile: opts.stateFile });
  return { router, registry, tasks };
}
