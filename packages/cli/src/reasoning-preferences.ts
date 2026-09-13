import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { reasoningPreferenceKey, type ModelEntry } from "@agent-router/core";

export class ReasoningPreferences {
  private values: Record<string, string> = {};
  private path: string;
  constructor(private dir: string) {
    this.path = join(dir, "reasoning.json");
    if (existsSync(this.path)) {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) this.values = Object.fromEntries(Object.entries(data).filter((entry): entry is [string,string] => typeof entry[1] === "string"));
    }
  }
  get(entry: ModelEntry): string | undefined { return this.values[reasoningPreferenceKey(entry)]; }
  set(entry: ModelEntry, effort?: string): void {
    const next = { ...this.values }, key = reasoningPreferenceKey(entry);
    if (effort === undefined) delete next[key]; else next[key] = effort;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.path); this.values = next;
  }
}
