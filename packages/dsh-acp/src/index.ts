#!/usr/bin/env node
/**
 * dsh-acp — DeepSeek Harness 的 ACP（Agent Client Protocol）服务器。
 *
 * 让任何 ACP client（本项目的 habor、OpenHands Agent Canvas、acp-agent-hub、
 * Zed、JetBrains…）都能把 DeepSeek 模型跑在 DeepSeek Harness 原生运行时里：
 *
 *   ACP client ──(JSON-RPC over stdio)──► dsh-acp ──► DSH Agent（in-process）
 *                                              ├─ session/new  → 创建真实 DSH Agent
 *                                              ├─ session/prompt → followup + 事件流
 *                                              │    assistant/chunk → agent_message_chunk
 *                                              │    tool/call → tool_call
 *                                              │    tool/result → tool_call_update
 *                                              │    usage → usage_update
 *                                              └─ approval/request → requestPermission
 *
 * 多轮会话：Agent 跨 prompt 存活（真正的会话记忆），这是 headless 一次性
 * 执行做不到的。
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { bootDsh, createDshAgent, type DshAgentHandle, type DshRuntime } from "./dsh-runtime.js";

const MODEL = process.env.DSH_ACP_MODEL;
const CONTEXT_SIZE = Number(process.env.DSH_ACP_CONTEXT_SIZE ?? 128000);

interface SessionRecord {
  handle: DshAgentHandle;
  cx: acp.AgentContext | null;
  watermark: number;
  usage: any;
  chunked: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function textFromBlocks(blocks: any[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

function usageOf(u: any): { used: number; size: number; cost?: unknown } | null {
  if (!u) return null;
  const used = u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  if (typeof used !== "number" || used <= 0) return null;
  return { used, size: CONTEXT_SIZE };
}

async function main(): Promise<void> {
  console.error(`[dsh-acp] booting DeepSeek Harness in-process...`);
  const runtime: DshRuntime = await bootDsh();
  console.error(`[dsh-acp] DSH core ready. serving ACP on stdio${MODEL ? ` (model=${MODEL})` : ""}`);

  const sessions = new Map<string, SessionRecord>();

  /** 消费新事件并推送 ACP 通知；返回是否遇到 turn/end 及其 reason。 */
  async function drain(rec: SessionRecord, acpSessionId: string): Promise<{ ended: boolean; reason?: any }> {
    const events = rec.handle.events();
    let ended = false;
    let reason: any;
    const cx = rec.cx;
    for (let i = rec.watermark; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === "turn/end") {
        ended = true;
        reason = ev.data?.reason;
        continue;
      }
      if (!cx) continue;
      const data = ev.data ?? {};
      try {
        if (ev.type === "assistant/chunk") {
          const chunk = data.chunk;
          if (chunk?.type === "text-delta" && chunk.text) {
            rec.chunked = true;
            await cx.notify(acp.methods.client.session.update, {
              sessionId: acpSessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk.text } }
            });
          } else if (chunk?.type === "reasoning-delta" && chunk.text) {
            await cx.notify(acp.methods.client.session.update, {
              sessionId: acpSessionId,
              update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk.text } }
            });
          }
        } else if (ev.type === "assistant/message") {
          // 若 chunk 已流式覆盖，跳过完整文本（避免客户端重复渲染）
          if (!rec.chunked) {
            const text = textFromBlocks(data.message?.content);
            if (text) {
              await cx.notify(acp.methods.client.session.update, {
                sessionId: acpSessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
              });
            }
          }
          const u = usageOf(data.usage);
          if (u) {
            rec.usage = data.usage;
            await cx.notify(acp.methods.client.session.update, {
              sessionId: acpSessionId,
              update: { sessionUpdate: "usage_update", used: u.used, size: u.size }
            });
          }
        } else if (ev.type === "tool/call") {
          let raw: unknown = {};
          try {
            raw = JSON.parse(data.arguments ?? "{}");
          } catch {
            raw = { arguments: data.arguments };
          }
          await cx.notify(acp.methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: data.callId,
              title: data.name,
              kind: "write",
              status: "pending",
              rawInput: raw
            }
          });
        } else if (ev.type === "tool/result") {
          const out = textFromBlocks(data.message?.content) || JSON.stringify(data.message ?? {}).slice(0, 2000);
          await cx.notify(acp.methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: data.message?.callId ?? "t",
              status: data.error ? "failed" : "completed",
              content: [{ type: "content", content: { type: "text", text: out.slice(0, 8000) } }]
            }
          });
        }
      } catch (err) {
        console.error(`[dsh-acp] notify failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    rec.watermark = events.length;
    return { ended, reason };
  }

  const app = acp
    .agent({ name: "dsh-acp" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false }
    }))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const sessionId = `dsh-${crypto.randomUUID().slice(0, 8)}`;
      const cwd = ctx.params.cwd ?? process.cwd();
      const model = (ctx.params as any)._meta?.model ?? MODEL;
      const handle = await createDshAgent(runtime, {
        cwd,
        model,
        onApproval: async (req) => {
          const rec = sessions.get(sessionId);
          if (!rec?.cx) return "unavailable";
          const resp = (await rec.cx.request(
            acp.methods.client.session.requestPermission as never,
            {
            sessionId,
            toolCall: {
              toolCallId: req.callId ?? req.id,
              title: req.toolName,
              kind: "write",
              status: "pending",
              rawInput: { reason: req.reason }
            },
            options: [
              { optionId: "allow", name: "允许此操作", kind: "allow_once" },
              { optionId: "reject", name: "拒绝此操作", kind: "reject_once" }
            ]
          } as never)) as acp.RequestPermissionResponse;
          if (resp.outcome.outcome === "selected" && resp.outcome.optionId === "allow") return "allowed-once";
          return "rejected";
        }
      });
      sessions.set(sessionId, { handle, cx: null, watermark: 0, usage: null, chunked: false });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const rec = sessions.get(ctx.params.sessionId);
      if (!rec) throw new Error(`session not found: ${ctx.params.sessionId}`);
      rec.cx = ctx.client;
      rec.watermark = rec.handle.events().length;
      rec.chunked = false;
      const text = textFromBlocks(ctx.params.prompt as any[]);
      try {
        rec.handle.followup(text || "（空消息）");
        for (;;) {
          const { ended, reason } = await drain(rec, ctx.params.sessionId);
          if (ended) {
            const kind = reason?.kind;
            if (kind === "completed") {
              return { stopReason: "end_turn" as const };
            }
            if (kind === "error") {
              throw new Error(reason?.error?.message ?? reason?.error?.code ?? "DSH turn error");
            }
            return { stopReason: "cancelled" as const };
          }
          await sleep(30);
        }
      } catch (err) {
        console.error("[dsh-acp] prompt handler error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
        throw err;
      } finally {
        rec.cx = null;
      }
    })
    .onRequest(acp.methods.agent.session.close, async (ctx) => {
      sessions.delete(ctx.params.sessionId);
      return {};
    })
    .onRequest(acp.methods.agent.session.delete, async (ctx) => {
      sessions.delete(ctx.params.sessionId);
      return {};
    });

  // 服务端：outgoing = stdout（Writable），incoming = stdin（Readable）
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );

  const connection = app.connect(stream);
  // connect() 是同步返回；保持进程存活直到连接真正关闭
  await connection.closed;
  console.error("[dsh-acp] connection closed, shutting down");
  await runtime.dispose();
  process.exit(0);
}

main().catch((err) => {
  console.error("[dsh-acp] fatal:", err);
  process.exit(1);
});
