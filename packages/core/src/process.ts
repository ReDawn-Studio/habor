import { execFile, type ChildProcess } from "node:child_process";

const stopping = new WeakMap<ChildProcess, Promise<void>>();

/** Close an owned stdio server normally before force-stopping its process tree. */
export async function closeProcess(child: ChildProcess, graceMs = 1500): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.stdin?.end();
  const timer = setTimeout(() => { void stopProcess(child); }, graceMs);
  try { await closed; } finally { clearTimeout(timer); }
}

/** Wait for owned processes and their stdio to close before releasing workspaces.
 * Windows signals alone can leave a native client behind its Node launcher.
 */
export function stopProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const pending = stopping.get(child);
  if (pending) return pending;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const work = new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    child.once("close", () => { clearTimeout(timer); resolve(); });
    if (process.platform === "win32") {
      // Only the PID of a child created by habor is passed; never kill by name.
      execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5000 }, error => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
    } else {
      child.kill(signal);
      timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    }
  });
  stopping.set(child, work);
  return work;
}
