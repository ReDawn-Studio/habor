import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface ClipboardOptions {
  write: (sequence: string) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

/** Use a local clipboard utility when available; OSC 52 targets an SSH client's clipboard. */
export async function writeClipboard(text: string, options: ClipboardOptions): Promise<boolean> {
  if (!text) return false;
  const { platform = process.platform, env = process.env, spawnProcess = spawn } = options;
  const encoded = Buffer.from(text, "utf8").toString("base64");
  if (!env.SSH_CONNECTION && !env.SSH_TTY) {
    const commands: Array<[string, string[], string]> = platform === "darwin" ? [["pbcopy", [], text]]
      : platform === "win32" ? [["powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadToEnd())))"], encoded]]
      : [["wl-copy", [], text], ["xclip", ["-selection", "clipboard"], text], ["xsel", ["--clipboard", "--input"], text]];
    for (const [command, args, input] of commands) {
      const success = await new Promise<boolean>(resolve => {
        let child: ChildProcessWithoutNullStreams;
        try { child = spawnProcess(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams; }
        catch { resolve(false); return; }
        let settled = false;
        const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, 2000);
        child.stdout.resume(); child.stderr.resume();
        child.once("error", () => finish(false));
        child.once("close", code => finish(code === 0));
        child.stdin.on("error", () => { child.kill("SIGKILL"); finish(false); });
        child.stdin.end(input, "utf8");
      });
      if (success) return true;
    }
  }
  try { options.write(`\x1b]52;c;${encoded}\x1b\\`); return true; }
  catch { return false; }
}
