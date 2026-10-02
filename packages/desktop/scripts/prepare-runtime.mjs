import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const runtime = join(desktop, "src-tauri", "runtime");
const bundled = join(root, "packages", "app-server", "dist", "index.mjs");
const node = process.execPath;
if (!existsSync(bundled)) throw new Error("Build packages/app-server before preparing the desktop runtime");
mkdirSync(join(runtime, "dist"), { recursive: true });
cpSync(bundled, join(runtime, "dist", "index.mjs"));
const nodeTarget = join(runtime, process.platform === "win32" ? "node.exe" : "node");
cpSync(node, nodeTarget);
if (process.platform !== "win32") spawnSync("chmod", ["+x", nodeTarget]);
writeFileSync(join(runtime, "runtime.json"), JSON.stringify({ version: "0.6.0", entry: "dist/index.mjs", node: "node" }, null, 2));
