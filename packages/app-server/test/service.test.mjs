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
