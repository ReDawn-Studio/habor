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
import { fileURLToPath } from "node:url";
import type { AcpAgentSpec } from "./acp.js";
import { documentedReasoning, agentExecutable, dshPackageAnchor } from "@agent-router/core";
import { hasCommand } from "./base.js";

const NPM_FLAGS = ["-y", "--silent"];

/** 定位 dsh-acp 入口：monorepo 构建产物优先，回退到全局命令。 */
function resolveDshAcpEntry(): string {
  const candidates = [
    // 构建产物（packages/adapters/dist → packages/dsh-acp/dist）
    fileURLToPath(new URL("../../dsh-acp/dist/index.js", import.meta.url)),
    // 源码运行（packages/adapters/src → packages/dsh-acp/dist）
    fileURLToPath(new URL("../../../dsh-acp/dist/index.js", import.meta.url)),
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
  command: ({ model, modelId, connection }) => ({
    cmd: process.execPath,
    argv: [resolveDshAcpEntry()],
    env: { DSH_ACP_MODEL: modelId ?? model, ...(connection ? { HABOR_DSH_BASE_URL: connection.baseUrl, HABOR_DSH_API_KEY: connection.apiKey } : {}) }
  }),
  isAvailable: async () => {
    try {
      return existsSync(resolveDshAcpEntry()) && !!dshPackageAnchor();
    } catch {
      return false;
    }
  }
};

export const kimiAcpSpec: AcpAgentSpec = {
  id: "kimi-acp",
  harnessName: "Kimi Code CLI (Kimi 官方 harness, ACP)",
  models: ["Kimi K3"],
  command: ({ modelId, connection }) => ({
    cmd: agentExecutable("kimi-acp"), argv: connection ? ["acp"] : ["-m", modelId ?? "kimi-code/k3", "acp"],
    ...(connection ? { env: {
      KIMI_MODEL_NAME: modelId, KIMI_MODEL_API_KEY: connection.apiKey, KIMI_MODEL_BASE_URL: connection.baseUrl,
      KIMI_MODEL_PROVIDER_TYPE: connection.protocol === "anthropic" ? "anthropic" : connection.protocol === "responses" ? "openai_responses" : "kimi",
      KIMI_MODEL_CAPABILITIES: documentedReasoning("kimi-acp", modelId ?? "").levels.length ? "tool_use,thinking" : "tool_use", KIMI_DISABLE_TELEMETRY: "1"
    } } : {})
  })
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

export const geminiAcpSpec: AcpAgentSpec = {
  id: "gemini-cli",
  harnessName: "Gemini CLI (Google 官方 ACP)",
  models: ["Gemini 3.8 Flash"],
  command: ({ modelId }) => ({ cmd: agentExecutable("gemini-cli"), argv: ["--acp", ...(modelId ? ["--model", modelId] : [])] }),
  isAvailable: async () => hasCommand(agentExecutable("gemini-cli"))
};

export const qwenAcpSpec: AcpAgentSpec = {
  id: "qwen-cli",
  harnessName: "Qwen Code (Qwen 官方 ACP)",
  models: ["Qwen 3.8 Max"],
  command: ({ modelId }) => ({ cmd: agentExecutable("qwen-cli"), argv: ["--acp", ...(modelId ? ["--model", modelId] : [])] }),
  isAvailable: async () => hasCommand(agentExecutable("qwen-cli"))
};

export const grokAcpSpec: AcpAgentSpec = {
  id: "grok-cli",
  harnessName: "Grok Build (xAI 官方 ACP)",
  models: ["Grok 4.6"],
  command: ({ modelId, permission }) => ({ cmd: agentExecutable("grok-cli"), argv: ["agent", ...(permission === "ask" ? [] : ["--always-approve"]), ...(modelId ? ["--model", modelId] : []), "stdio"] }),
  isAvailable: async () => hasCommand(agentExecutable("grok-cli"))
};
