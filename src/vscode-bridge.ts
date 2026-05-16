import { spawn } from "node:child_process";

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

export const defaultHeadless: HeadlessFn = ({ sessionUuid, cwd, prompt, maxBudgetUsd = 5, timeoutMs = 120_000 }) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    // On Windows, `claude` is typically a .cmd shim. Use cmd.exe with /D /C and pass the
    // prompt via stdin to avoid quoting nightmares with multibyte / quotes / backticks.
    // Spawn `claude` directly (claude.exe on Windows, claude on POSIX).
    // Pass prompt via STDIN. KNOWN LIMITATION on Windows: non-ASCII characters in
    // the prompt get mangled in claude.exe's stdin parsing (system codepage issue).
    // English prompts work correctly. See README "Known Limitations".
    const child = spawn(
      "claude",
      ["-r", sessionUuid, "-p", "--max-budget-usd", String(maxBudgetUsd)],
      { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
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
      if (code === 0) resolve({ reply: stdout.trim(), exitCode: code, durationMs });
      else reject(new Error(`headless claude exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });

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
   * Headless submit: actually run Claude with the prompt against the given session.
   * Transcript is appended on disk → VSCode picks up the new user msg + Claude reply.
   * Costs real API money. Caller chooses this vs prefill.
   */
  async submit(args: { sessionUuid: string; cwd: string; prompt: string; maxBudgetUsd?: number; timeoutMs?: number }): Promise<{ reply: string; exitCode: number; durationMs: number }> {
    return this.headless(args);
  }
}
