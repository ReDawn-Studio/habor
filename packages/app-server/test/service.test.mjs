import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopService } from "../src/service.mjs";

test("desktop service keeps workspace trust and file paths bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "habor-app-server-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export const ok = true;\n");
  const service = new DesktopService({ stateDir: join(root, ".state") });
  try {
    const before = await service.call("snapshot");
    assert.equal(before.trusted, false);
    const opened = await service.call("workspace.open", { path: root });
    assert.equal(opened.trusted, false);
    await service.call("workspace.trust", { path: opened.cwd });
    const files = await service.call("files.list", { path: "." });
    assert.ok(files.entries.some((entry) => entry.path === "src"));
    const text = await service.call("files.read", { path: "src/main.ts" });
    assert.match(text.text, /export const ok/);
    await assert.rejects(() => service.call("files.read", { path: "../outside.ts" }), /workspace|Path escapes|ENOENT/);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop service continues a task through the shared Router session", async () => {
  const root = await mkdtemp(join(tmpdir(), "habor-app-server-task-"));
  const adapter = { id: "dsh-acp", harnessName: "Mock", models: ["DeepSeek V4 Flash"], protocol: "acp", isAvailable: async () => true, createSession: async (options) => ({ id: "mock-session", adapterId: "dsh-acp", model: options.model, cwd: options.cwd, prompt: async function* () { yield { type: "message", text: "mock assistant reply", ts: Date.now(), sessionId: "mock-session", adapterId: "dsh-acp", model: options.model }; yield { type: "done", ts: Date.now(), sessionId: "mock-session", adapterId: "dsh-acp", model: options.model }; }, cancel: async () => {}, close: async () => {} }) };
  const service = new DesktopService({ stateDir: join(root, ".state"), adapters: [adapter] });
  try {
    const opened = await service.call("workspace.open", { path: root });
    await service.call("workspace.trust", { path: opened.cwd });
    const task = await service.call("tasks.create", { title: "Conversation smoke", model: "DeepSeek V4 Flash", permission: "ask" });
    const accepted = await service.call("tasks.send", { taskId: task.id, input: "hello" });
    assert.equal(accepted.accepted, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot = await service.call("snapshot");
    const saved = snapshot.tasks.find((item) => item.id === task.id);
    assert.ok(saved.conversation.some((turn) => turn.text === "mock assistant reply"));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
