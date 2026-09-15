import { existsSync, mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** A small, secret-free allowlist for directories the user has explicitly trusted. */
export class WorkspaceTrust {
  private paths = new Set<string>();
  private readonly file: string;
  constructor(private dir: string) {
    this.file = join(dir, "trust.json");
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(data.paths)) this.paths = new Set(data.paths.filter((path: unknown): path is string => typeof path === "string"));
    } catch { /* First run. */ }
  }
  canonical(cwd: string): string { try { return realpathSync(cwd); } catch { return cwd; } }
  isTrusted(cwd: string): boolean { return this.paths.has(this.canonical(cwd)); }
  trust(cwd: string): void {
    const path = this.canonical(cwd); this.paths.add(path); mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = join(this.dir, `.trust.${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify({ version: 1, paths: [...this.paths] }, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.file);
  }
}
