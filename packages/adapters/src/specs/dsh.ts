/**
 * adapters/specs/dsh.ts — DeepSeek Harness（声明式 spec）。
 *
 * v1：`dsh --profile headless "任务"`（一次性，stdout = 最终文本）。
 * v2 计划：in-process 驱动 DSH Agent，拿到 tool/call、approval/asked、
 * compaction 等真实事件流（届时只需换一个 spec 的实现形态）。
 */
import type { CliAgentSpec } from "../framework.js";

export const dshSpec: CliAgentSpec = {
  id: "dsh",
  harnessName: "DeepSeek Harness",
  models: ["DeepSeek V4 Flash", "DeepSeek V4 Pro"],
  collectText: true,
  buildCommand: ({ prompt }) => ({
    cmd: "dsh",
    argv: ["--profile", "headless", prompt]
  }),
  onExit: ({ exitCode, stderr, timedOut }, emit) => {
    if (exitCode !== 0 || timedOut) {
      emit({
        type: "error",
        error: { message: stderr.trim() || "headless 运行失败", code: String(exitCode) }
      });
    }
  }
};
