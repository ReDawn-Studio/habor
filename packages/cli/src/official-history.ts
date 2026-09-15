import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

export type OfficialSource = "Codex" | "Claude Code" | "Kimi Code";
export interface OfficialTurn { role: "user" | "assistant"; text: string }
export interface OfficialHistory {
  id: string;
  source: OfficialSource;
  title: string;
  cwd: string;
  updatedAt: number;
  model?: string;
  turns: OfficialTurn[];
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return textOf(item.text ?? item.content ?? item.message ?? "");
  }
  return "";
}
function canonical(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}
function sameCwd(a: string | undefined, cwd: string): boolean { return !!a && canonical(a) === canonical(cwd); }
function walk(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(".jsonl")) files.push(path);
    }
  };
  try { visit(root); } catch { /* Official history can be locked or removed while scanning. */ }
  return files;
}
function sqlite(query: string, db = join(homedir(), ".codex/sqlite/codex-dev.db")): any[] {
  const result = spawnSync("sqlite3", ["-json", db, query], { encoding: "utf8", timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.trim()) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}
function codexHistories(cwd: string): OfficialHistory[] {
  if (!existsSync(join(homedir(), ".codex/sqlite/codex-dev.db"))) return [];
  const rows = sqlite("select thread_id,display_title,cwd,source_updated_at,model_provider from local_thread_catalog where cwd is not null order by source_updated_at desc");
  return rows.filter(row => sameCwd(row.cwd, cwd)).map(row => {
    const id = String(row.thread_id);
    if (!/^[A-Za-z0-9-]+$/.test(id)) return undefined;
    const items = sqlite(`select item_type,item_json from thread_items where thread_id='${id}' order by created_at_ms asc`, join(homedir(), ".codex/thread_history_1.sqlite"));
    const turns: OfficialTurn[] = [];
    for (const item of items) {
      try {
        const data = JSON.parse(item.item_json);
        if (item.item_type === "userMessage") { const text = textOf(data.content); if (text) turns.push({ role: "user", text }); }
        if (item.item_type === "agentMessage") { const text = textOf(data.text); if (text) turns.push({ role: "assistant", text }); }
      } catch { /* Ignore a partially written history item. */ }
    }
    return { id: `codex:${id}`, source: "Codex", title: String(row.display_title || turns.find(turn => turn.role === "user")?.text || "Codex 会话").slice(0, 120), cwd, updatedAt: Number(row.source_updated_at || 0), model: row.model_provider ? String(row.model_provider) : undefined, turns: turns.slice(-80) };
  }).filter(Boolean) as OfficialHistory[];
}
function claudeHistories(cwd: string): OfficialHistory[] {
  const groups = new Map<string, OfficialHistory>();
  for (const file of walk(join(homedir(), ".claude/projects"))) {
    for (const line of readLines(file)) {
      const data = line.data;
      if (!sameCwd(data.cwd, cwd) || !data.sessionId || !["user", "assistant"].includes(data.type)) continue;
      const id = String(data.sessionId);
      const group = groups.get(id) ?? { id: `claude:${id}`, source: "Claude Code", title: "Claude Code 会话", cwd, updatedAt: 0, turns: [] };
      group.updatedAt = Math.max(group.updatedAt, Date.parse(data.timestamp || "") || 0);
      const text = textOf(data.message?.content);
      if (text && (group.turns.length === 0 || group.turns.at(-1)!.text !== text)) group.turns.push({ role: data.type, text });
      if (data.type === "user" && group.title === "Claude Code 会话") group.title = text.slice(0, 120) || group.title;
      groups.set(id, group);
    }
  }
  return [...groups.values()].map(group => ({ ...group, turns: group.turns.slice(-80) }));
}
function readLines(file: string): Array<{ data: any }> {
  const result: Array<{ data: any }> = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) { try { result.push({ data: JSON.parse(line) }); } catch {} }
  } catch {}
  return result;
}
function kimiHistories(cwd: string): OfficialHistory[] {
  const index = join(homedir(), ".kimi-code/session_index.jsonl");
  const output: OfficialHistory[] = [];
  for (const line of readLines(index)) {
    const row = line.data;
    if (!sameCwd(row.workDir, cwd) || !row.sessionId) continue;
    const dir = String(row.sessionDir || "");
    const wire = join(dir, "agents/main/wire.jsonl");
    const turns: OfficialTurn[] = [];
    let model: string | undefined;
    for (const event of readLines(wire)) {
      const data = event.data;
      if (data.type === "profile.bind") model = data.modelAlias || model;
      if (data.type === "context.append_message") {
        const text = textOf(data.message?.content);
        if (text && ["user", "assistant"].includes(data.message?.role)) turns.push({ role: data.message.role, text });
      }
    }
    output.push({ id: `kimi:${row.sessionId}`, source: "Kimi Code", title: turns.find(turn => turn.role === "user")?.text?.slice(0, 120) || "Kimi Code 会话", cwd, updatedAt: Number(row.updatedAt || 0), model, turns: turns.slice(-80) });
  }
  return output;
}
export function listOfficialHistories(cwd: string): OfficialHistory[] {
  return [...codexHistories(cwd), ...claudeHistories(cwd), ...kimiHistories(cwd)].sort((a, b) => b.updatedAt - a.updatedAt);
}
