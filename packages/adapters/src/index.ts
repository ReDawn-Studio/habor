/**
 * adapters/index.ts — 从声明式 specs 构建全部原生 harness adapter。
 *
 * 接入新的 agent 只需要：
 *   1. 写一个 spec（CLI 子进程 或 ACP server 两种传输形态）
 *   2. 在这里 import + 加入数组
 *   3. 在 core/registry.ts 的 MODEL_CATALOG 里登记「用户可见模型 → adapterId」
 */
import type { Adapter } from "@agent-router/core";
import { createAcpAdapter, type AcpAgentSpec } from "./acp.js";
import { createAcpBridgeAdapter } from "./acp-bridge.js";
import { ZcodeStreamAdapter } from "./zcode-stream.js";
import { CodexNativeAdapter } from "./codex-native.js";
import { ClaudeNativeAdapter } from "./claude-native.js";
import { dshAcpSpec, kimiAcpSpec, claudeAcpSpec, codexAcpSpec, geminiAcpSpec, qwenAcpSpec, grokAcpSpec } from "./specs-acp.js";

export { createCliAdapter, type CliAgentSpec } from "./framework.js";
export type { CliRunContext, Emit, CliExitContext } from "./framework.js";
export { createAcpAdapter, type AcpAgentSpec } from "./acp.js";
export { createAcpBridgeAdapter } from "./acp-bridge.js";
export { ZcodeStreamAdapter } from "./zcode-stream.js";

/**
 * 全部 adapter：
 *   - dsh / kimi → 原生 ACP 传输（多轮会话）
 *   - codex / claude / zcode → ACP bridge（把各家的私有 CLI/RPC 包进同一
 *     ACP session 生命周期；未来厂商提供原生 ACP 时可无感替换）
 * 新增 agent 加在这里。
 */
export const ALL_ACP_SPECS: AcpAgentSpec[] = [dshAcpSpec, kimiAcpSpec, claudeAcpSpec, codexAcpSpec, geminiAcpSpec, qwenAcpSpec, grokAcpSpec];

/**
 * 构建全部 adapter（注入给路由层）。
 * 路由层不感知具体 harness，只通过 Adapter 接口使用。
 */
export function createAdapters(): Adapter[] {
  const adapters: Adapter[] = [];
  for (const spec of [dshAcpSpec, kimiAcpSpec]) adapters.push(createAcpAdapter(spec));
  adapters.push(createAcpBridgeAdapter(new CodexNativeAdapter()));
  adapters.push(createAcpBridgeAdapter(new ClaudeNativeAdapter()));
  adapters.push(createAcpBridgeAdapter(new ZcodeStreamAdapter()));
  for (const spec of [geminiAcpSpec, qwenAcpSpec, grokAcpSpec]) adapters.push(createAcpAdapter(spec));
  return adapters;
}
