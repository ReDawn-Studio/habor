/**
 * adapters/specs/zcode.ts — ZCode（GLM 官方 harness）（声明式 spec）。
 *
 * ZCode 没有独立安装的 CLI，但桌面端内置真实 CLI（已实测可用）：
 *   /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs  (zcode 0.16.5)
 *   node zcode.cjs --prompt "..." --mode yolo --cwd <dir> → 文本输出
 * 需要的模型配置（已生成到 ~/.zcode/cli/config.json）：
 *   { "provider": {...}, "model": { "main": "bigmodel-coding-plan/GLM-5.3" } }
 *
 * v2 可用 --resume <sessionId> 做多轮，或 app-server（JSON-RPC over stdio）双向流式。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliAgentSpec } from "../framework.js";
import { runCli } from "../base.js";

const ZCODE_MODELS = ["GLM-5.3"];

function resolveZcodeCli(): string | undefined {
  if (process.env.ZCODE_CLI && existsSync(process.env.ZCODE_CLI)) return process.env.ZCODE_CLI;
  const candidates = [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    join(homedir(), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")
  ];
  return candidates.find((p) => existsSync(p));
}

const cliPath = resolveZcodeCli();

export const zcodeSpec: CliAgentSpec = {
  id: "zcode",
  harnessName: "ZCode (GLM 官方 harness)",
  models: ZCODE_MODELS,
  collectText: true,
  buildCommand: ({ prompt, cwd, permission }) => ({
    cmd: process.execPath,
    argv: [
      cliPath!,
      "--prompt",
      prompt,
      "--mode",
      permission === "ask" ? "build" : "yolo",
      "--cwd",
      cwd,
      "--surface",
      "terminal"
    ]
  }),
  isAvailable: async () => {
    if (!cliPath) return false;
    const r = await runCli({ cmd: process.execPath, argv: [cliPath, "version"], timeoutMs: 15000 });
    return r.exitCode === 0;
  },
  onExit: ({ exitCode, stderr }, emit) => {
    if (exitCode !== 0 && stderr.trim()) {
      emit({ type: "error", error: { message: stderr.trim(), code: String(exitCode) } });
    }
  }
};
