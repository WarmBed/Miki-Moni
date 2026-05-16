import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Hook-reported cwd ≠ where the session's transcript actually lives.
 * Find the directory under ~/.claude/projects/ that contains `<sessionUuid>.jsonl`.
 * Falls back to the original cwd if nothing is found.
 */
export async function resolveSessionCwd(sessionUuid: string, fallbackCwd: string): Promise<string> {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await fs.readdir(projectsRoot);
  } catch {
    return fallbackCwd;
  }
  for (const d of dirs) {
    const candidate = path.join(projectsRoot, d, `${sessionUuid}.jsonl`);
    try {
      await fs.access(candidate);
      // Decode the encoded dir name back to a real cwd: "D--code-openruterati" → "d:\code\openruterati"
      const decoded = d
        .replace(/^([A-Za-z])--/, (_, letter) => `${letter.toLowerCase()}:\\`)
        .replace(/-/g, "\\");
      return decoded;
    } catch {
      // not in this dir, keep looking
    }
  }
  return fallbackCwd;
}

export type LaunchFn = (url: string) => Promise<void>;

export const defaultLaunch: LaunchFn = (url) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process -FilePath '${url.replace(/'/g, "''")}'`],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on("error", reject);
  });

// Headless: run `claude -r <session_uuid> -p "<prompt>"` in the session's cwd.
// Returns Claude's plaintext reply. Throws on non-zero exit or timeout.
export type HeadlessFn = (opts: {
  sessionUuid: string;
  cwd: string;
  prompt: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
}) => Promise<{ reply: string; exitCode: number; durationMs: number }>;

export const defaultHeadless: HeadlessFn = async ({ sessionUuid, cwd, prompt, maxBudgetUsd = 5, timeoutMs = 120_000 }) => {
  // The session's transcript may live in a different workspace than the cwd
  // the daemon last saw (hooks fire with whatever sub-dir was active). Find the
  // real one or `claude -r <id>` will fail with "No conversation found".
  const actualCwd = await resolveSessionCwd(sessionUuid, cwd);
  return new Promise<{ reply: string; exitCode: number; durationMs: number }>((resolve, reject) => {
    const start = Date.now();
    // Spawn `claude` directly (claude.exe on Windows, claude on POSIX).
    // Pass prompt via STDIN. KNOWN LIMITATION on Windows: non-ASCII characters in
    // the prompt get mangled in claude.exe's stdin parsing (system codepage issue).
    // English prompts work correctly. See README "Known Limitations".
    const child = spawn(
      "claude",
      ["-r", sessionUuid, "-p", "--max-budget-usd", String(maxBudgetUsd)],
      { cwd: actualCwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
    );
    child.stdin?.write(Buffer.from(prompt, "utf8"));
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error(`headless claude timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const reply = stdout.trim();
      // Tolerate non-zero exit when the response was actually generated. Claude
      // Code's community lifecycle hook (session-lifecycle-hook.mjs SessionEnd)
      // sometimes fails AFTER the model already produced a response, causing
      // claude.exe to exit 1 with empty stderr — but the reply IS on stdout
      // and IS in the transcript. Treat that as success.
      if (reply) {
        resolve({ reply, exitCode: code ?? 0, durationMs });
        return;
      }
      reject(new Error(
        `headless claude exited ${code} (cwd=${actualCwd}, empty stdout): ${stderr.trim().slice(0, 500) || "(empty stderr too — likely SessionEnd hook failure with no response generated)"}`,
      ));
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
};

export class VscodeBridge {
  constructor(
    private launch: LaunchFn = defaultLaunch,
    private headless: HeadlessFn = defaultHeadless,
  ) {}

  async focus(sessionUuid: string | null): Promise<void> {
    const base = "vscode://anthropic.claude-code/open";
    const url = sessionUuid ? `${base}?session=${sessionUuid}` : base;
    await this.launch(url);
  }

  /**
   * Pre-fill the prompt in the Claude panel input box (does NOT submit).
   * Uses vscode://anthropic.claude-code/open?session=...&prompt=...
   */
  async send(sessionUuid: string | null, prompt: string): Promise<void> {
    const parts: string[] = [];
    if (sessionUuid) parts.push(`session=${encodeURIComponent(sessionUuid)}`);
    parts.push(`prompt=${encodeURIComponent(prompt)}`);
    const url = `vscode://anthropic.claude-code/open?${parts.join("&")}`;
    await this.launch(url);
  }

  /**
   * Prefill + auto-press Enter in the focused window. Uses Win32 SendKeys.
   * Workflow: vscode:// URI prefills → VSCode comes forward and focuses input
   * box → after a short delay we send {ENTER} to whatever is foreground.
   *
   * The user's live VSCode panel session handles the prompt (cache hot, cheap).
   *
   * Risk: if foreground-lock prevents VSCode from coming forward, Enter goes
   * to whatever app IS foreground (e.g. browser → could submit a form).
   * Caller should be aware. We mitigate by raising VSCode via the URI handler
   * which Explorer dispatches (Explorer has SetForegroundWindow permission).
   */
  async prefillAndSubmit(sessionUuid: string | null, prompt: string, delayMs = 800): Promise<void> {
    if (process.platform !== "win32") {
      // POSIX: no equivalent reliable SendKeys; just prefill.
      await this.send(sessionUuid, prompt);
      return;
    }
    const parts: string[] = [];
    if (sessionUuid) parts.push(`session=${encodeURIComponent(sessionUuid)}`);
    parts.push(`prompt=${encodeURIComponent(prompt)}`);
    const url = `vscode://anthropic.claude-code/open?${parts.join("&")}`;
    // Build a single PowerShell command that:
    //   1. Start-Process the URI (Windows dispatches to VSCode handler)
    //   2. Sleep delayMs (let VSCode raise + focus prompt input)
    //   3. Add-Type System.Windows.Forms; SendKeys ENTER
    // We use the call operator (&) and chain with semicolons. SendWait blocks
    // until input is processed.
    const ps = [
      `Start-Process -FilePath '${url.replace(/'/g, "''")}'`,
      `Start-Sleep -Milliseconds ${delayMs}`,
      `Add-Type -AssemblyName System.Windows.Forms`,
      `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`,
    ].join("; ");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-Command", ps],
        { stdio: "ignore", windowsHide: true },
      );
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`prefillAndSubmit exit ${code}`))));
      child.on("error", reject);
    });
  }

  /**
   * Headless submit: actually run Claude with the prompt against the given session.
   * Transcript is appended on disk → VSCode picks up the new user msg + Claude reply.
   * Costs real API money. Caller chooses this vs prefill.
   */
  async submit(args: { sessionUuid: string; cwd: string; prompt: string; maxBudgetUsd?: number; timeoutMs?: number }): Promise<{ reply: string; exitCode: number; durationMs: number }> {
    return this.headless(args);
  }
}
