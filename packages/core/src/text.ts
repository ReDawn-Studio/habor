import type { AgentEvent } from "./types.js";

/** Protocol payloads are runtime values, even when an adapter casts them to string. */
export function toDisplayText(value: unknown): string {
  const seen = new WeakSet<object>();
  const convert = (item: unknown): string => {
    if (item == null) return "";
    if (typeof item === "string") return item;
    if (typeof item !== "object") return String(item);
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    try {
      if (item instanceof Error) return item.message;
      if (Array.isArray(item)) return item.map(convert).filter(Boolean).join("\n");
      const record = item as Record<string, unknown>;
      for (const field of ["text", "message", "error", "content"]) {
        if (record[field] != null) return convert(record[field]);
      }
      const jsonSeen = new WeakSet<object>();
      return JSON.stringify(item, (_key, entry: unknown) => {
        if (typeof entry === "bigint") return entry.toString();
        if (entry && typeof entry === "object") {
          if (jsonSeen.has(entry)) return "[Circular]";
          jsonSeen.add(entry);
        }
        return entry;
      }, 2) ?? "";
    } finally {
      seen.delete(item);
    }
  };
  try { return convert(value); }
  catch { return "[无法显示的内容]"; }
}

/** Keep the public event contract true before rendering or persisting adapter output. */
export function normalizeEventText(event: AgentEvent): AgentEvent {
  const normalized = { ...event };
  if (event.delta !== undefined) normalized.delta = toDisplayText(event.delta);
  if (event.text !== undefined) normalized.text = toDisplayText(event.text);
  if (event.thinking !== undefined) normalized.thinking = toDisplayText(event.thinking);
  if (event.tool) normalized.tool = { ...event.tool, id: toDisplayText(event.tool.id), name: toDisplayText(event.tool.name) };
  if (event.toolResult) normalized.toolResult = {
    ...event.toolResult, id: toDisplayText(event.toolResult.id), name: toDisplayText(event.toolResult.name), output: toDisplayText(event.toolResult.output)
  };
  if (event.terminal) normalized.terminal = { ...event.terminal, command: toDisplayText(event.terminal.command), output: toDisplayText(event.terminal.output) };
  if (event.error) normalized.error = { ...event.error, message: toDisplayText(event.error.message) };
  return normalized;
}
