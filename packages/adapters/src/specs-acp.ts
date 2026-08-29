/**
 * adapters/specs-acp.ts — 走 ACP 传输的原生 harness 接入（声明式 spec）。
 *
 * 依据 OpenHands 官方文档确认的 ACP 入口 + 本机登录态自动复用：
 *   - dsh：本项目自建的 dsh-acp（DeepSeek Harness ACP server，in-process）
 *   - kimi：`kimi acp`（Kimi Code CLI 原生 ACP server）
 *   - claude：`npx -y @agentclientprotocol/claude-agent-acp`（官方包装）
 *   - codex：`npx -y @zed-industries/codex-acp`（Zed 官方包装）
 * 认证：订阅/OAuth 登录自动检测（Keychain / ~/.codex/auth.json / ~/.kimi-code 等），
 *       本地无需 API key。
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AcpAgentSpec } from "./acp.js";

const NPM_FLAGS = ["-y", "--silent"];

/** 定位 dsh-acp 入口：monorepo 构建产物优先，回退到全局命令。 */
function resolveDshAcpEntry(): string {
  const candidates = [
    // 构建产物（packages/adapters/dist → packages/dsh-acp/dist）
    new URL("../../dsh-acp/dist/index.js", import.meta.url).pathname,
    // 源码运行（packages/adapters/src → packages/dsh-acp/dist）
    new URL("../../../dsh-acp/dist/index.js", import.meta.url).pathname,
    // 仓库根目录运行时
    join(process.cwd(), "packages/dsh-acp/dist/index.js")
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return "dsh-acp"; // 回退：期望全局安装（npm i -g @agent-router/dsh-acp）
}

export const dshAcpSpec: AcpAgentSpec = {
  id: "dsh-acp",
  harnessName: "DeepSeek Harness (ACP, in-process)",
  models: ["DeepSeek V4 Flash", "DeepSeek V4 Pro"],
  command: ({ model }) => ({
    cmd: process.execPath,
    argv: [resolveDshAcpEntry()],
    env: { DSH_ACP_MODEL: model }
  }),
  isAvailable: async () => {
    try {
      return existsSync(resolveDshAcpEntry()) || (await import("./base.js")).hasCommand("dsh-acp");
    } catch {
      return false;
    }
  }
};

export const kimiAcpSpec: AcpAgentSpec = {
  id: "kimi-acp",
  harnessName: "Kimi Code CLI (Kimi 官方 harness, ACP)",
  models: ["Kimi K3"],
  command: () => ({ cmd: "kimi", argv: ["acp"] })
};

export const claudeAcpSpec: AcpAgentSpec = {
  id: "claude-acp",
  harnessName: "Claude Code (Anthropic 官方 harness, ACP)",
  models: ["Claude Sonnet 4.6"],
  command: () => ({
    cmd: "npx",
    argv: [...NPM_FLAGS, "@agentclientprotocol/claude-agent-acp"]
  })
};

export const codexAcpSpec: AcpAgentSpec = {
  id: "codex-acp",
  harnessName: "Codex (OpenAI 官方 harness, ACP)",
  models: ["GPT-5.5"],
  command: () => ({
    cmd: "npx",
    argv: [...NPM_FLAGS, "@zed-industries/codex-acp"]
  })
};
