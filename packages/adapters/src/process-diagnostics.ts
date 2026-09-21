import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "@agent-router/core";

/** Bounded, redacted stderr for a failed transport; never paint child output live. */
export class ProcessDiagnostics {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private discarding = false;
  private output = "";
  constructor(private secrets: string[]) {}
  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let split: number;
    while ((split = this.pending.indexOf("\n")) >= 0) {
      if (!this.discarding) this.append(this.pending.slice(0, split));
      this.discarding = false;
      this.pending = this.pending.slice(split + 1);
    }
    // Drop oversized lines whole: truncating a raw key could evade redaction.
    if (this.pending.length > 16384) { this.pending = ""; this.discarding = true; }
  }
  finish(): void {
    this.pending += this.decoder.end();
    if (!this.discarding && this.pending) this.append(this.pending);
    this.pending = "";
  }
  private append(line: string): void {
    const safe = redactSecrets(line, this.secrets)
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
      .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)(?:Bearer\s+)?[^\s,]+/gi, "$1[REDACTED]");
    this.output = (this.output + safe + "\n").slice(-8000);
  }
  text(): string { return this.output.trim(); }
}
