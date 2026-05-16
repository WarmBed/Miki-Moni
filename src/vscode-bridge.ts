import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Hook-reported cwd ≠ where the session's transcript actually lives.
 * Find the directory under ~/.claude/projects/ that contains `<sessionUuid>.jsonl`,
 * then read the actual cwd from the JSONL itself (entries carry a `cwd` field
 * with the real workspace path).
 *
 * Why not decode the folder name (e.g. "D--code-cc-hub-tests"): Claude Code
 * encodes both `\` and `-` as `-`, so the encoding is lossy — "cc-hub" inside
 * the path becomes ambiguous. The JSONL `cwd` field is the source of truth.
 *
 * Falls back to the caller-provided cwd if nothing is found.
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
      // Found the transcript. Read it and pull cwd from the first entry that has one.
      try {
        const raw = await fs.readFile(candidate, "utf8");
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          if (!line || !line.includes('"cwd"')) continue;
          try {
            const e = JSON.parse(line);
            if (typeof e?.cwd === "string" && e.cwd) return e.cwd;
          } catch { /* keep scanning */ }
        }
      } catch { /* file read failed — fall through */ }
      // No cwd in JSONL; use fallback rather than guess from folder name.
      return fallbackCwd;
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

// Resolve the `claude` executable to an absolute path so spawn doesn't depend
// on daemon PATH inheritance (which can be empty depending on how the daemon
// was launched). Tries common Windows + POSIX install locations.
let resolvedClaudePathCache: string | null = null;
async function resolveClaudePath(): Promise<string> {
  if (resolvedClaudePathCache) return resolvedClaudePathCache;
  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [
        path.join(home, ".local", "bin", "claude.exe"),
        path.join(home, ".local", "bin", "claude.cmd"),
        path.join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
      ]
    : [
        "/usr/local/bin/claude",
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".npm-global", "bin", "claude"),
      ];
  for (const p of candidates) {
    try { await fs.access(p); resolvedClaudePathCache = p; return p; } catch { /* try next */ }
  }
  // Last resort: trust PATH and hope for the best. spawn will ENOENT clearly.
  return "claude";
}

export const defaultHeadless: HeadlessFn = async ({ sessionUuid, cwd, prompt, maxBudgetUsd = 5, timeoutMs = 120_000 }) => {
  // The session's transcript may live in a different workspace than the cwd
  // the daemon last saw (hooks fire with whatever sub-dir was active). Find the
  // real one or `claude -r <id>` will fail with "No conversation found".
  const actualCwd = await resolveSessionCwd(sessionUuid, cwd);
  const claudeBin = await resolveClaudePath();
  return new Promise<{ reply: string; exitCode: number; durationMs: number }>((resolve, reject) => {
    const start = Date.now();
    // Spawn claude.exe via absolute path. Pass prompt via STDIN.
    // KNOWN LIMITATION on Windows: non-ASCII characters in the prompt get
    // mangled in claude.exe's stdin parsing (system codepage issue).
    // English prompts work correctly. See README "Known Limitations".
    const child = spawn(
      claudeBin,
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

/**
 * Build a PowerShell script that fires a vscode:// URI, then explicitly finds
 * a VSCode top-level window via Win32 EnumWindows, force-focuses it (defeating
 * the foreground-stealing block with AttachThreadInput), and SendKeys ENTER.
 *
 * The `'@` here-string terminator MUST be at column 0 in the produced script,
 * so this function builds the script with no indentation on that line.
 */
function buildFocusAndEnterPS(url: string, folderHint: string, delayMs: number): string {
  const u = url.replace(/'/g, "''");
  const h = folderHint.replace(/'/g, "''");
  // Note: the C# signature here-string MUST start with `@'` and end with `'@`
  // both at column 0 of their line. JS template literal preserves indentation,
  // so we avoid leading whitespace on those marker lines.
  return `
$ErrorActionPreference = 'Stop'

Start-Process -FilePath '${u}'
Start-Sleep -Milliseconds ${delayMs}

$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
[DllImport("user32.dll")] public static extern bool LockSetForegroundWindow(uint uLockCode);
[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint dwProcessId);
'@
Add-Type -MemberDefinition $sig -Name 'U' -Namespace 'CcHub'

$candidates = New-Object System.Collections.ArrayList
$proc = [CcHub.U+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  if (-not [CcHub.U]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [CcHub.U]::GetWindowText($h, $sb, 512) | Out-Null
  $title = $sb.ToString()
  if ($title -match 'Visual Studio Code') {
    [void]$candidates.Add(@{ Hwnd = $h; Title = $title })
  }
  return $true
}
[CcHub.U]::EnumWindows($proc, [IntPtr]::Zero) | Out-Null

# Pick: (1) workspace-folder-hint match preferred, (2) current foreground if VSCode,
# (3) first VSCode window.
$best = $null
$hint = '${h}'
if ($hint -ne '') {
  $best = $candidates | Where-Object { $_.Title -match [regex]::Escape($hint) } | Select-Object -First 1
}
if (-not $best) {
  $fg = [CcHub.U]::GetForegroundWindow()
  $best = $candidates | Where-Object { $_.Hwnd -eq $fg } | Select-Object -First 1
}
if (-not $best -and $candidates.Count -gt 0) { $best = $candidates[0] }

Write-Output ("candidates=" + $candidates.Count)
foreach ($c in $candidates) { Write-Output ("  cand hwnd=" + $c.Hwnd + " title=" + $c.Title) }

if (-not $best) {
  Write-Error ("No VSCode window found (candidates: " + $candidates.Count + ")")
  exit 2
}

$fgBefore = [CcHub.U]::GetForegroundWindow()
$hwnd = $best.Hwnd
Write-Output ("picked hwnd=" + $hwnd + " title=" + $best.Title)
Write-Output ("fg-before hwnd=" + $fgBefore)

if ([CcHub.U]::IsIconic($hwnd)) { [CcHub.U]::ShowWindow($hwnd, 9) | Out-Null }  # SW_RESTORE

# Defeat Win10/11 foreground lock — proven AutoHotkey recipe:
#   1. LockSetForegroundWindow(LSFW_UNLOCK=2) — explicit unlock
#   2. keybd_event ALT down/up — simulated user input grants this thread
#      foreground rights for one SetForegroundWindow call (the classic trick)
#   3. AttachThreadInput to target VSCode thread (defeats ownership check)
#   4. SetForegroundWindow + BringWindowToTop
#   5. SwitchToThisWindow as belt-and-suspenders (undocumented but bypasses lock)
[CcHub.U]::LockSetForegroundWindow(2) | Out-Null  # LSFW_UNLOCK
[CcHub.U]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)             # VK_MENU down
[CcHub.U]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)             # VK_MENU up (KEYEVENTF_KEYUP=2)
Start-Sleep -Milliseconds 30

$targetTid = [CcHub.U]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$myTid     = [CcHub.U]::GetCurrentThreadId()
$attachOk  = [CcHub.U]::AttachThreadInput($myTid, $targetTid, $true)
$setFgOk   = [CcHub.U]::SetForegroundWindow($hwnd)
[CcHub.U]::BringWindowToTop($hwnd) | Out-Null
[CcHub.U]::SwitchToThisWindow($hwnd, $true)
[CcHub.U]::AttachThreadInput($myTid, $targetTid, $false) | Out-Null
Start-Sleep -Milliseconds 200

$fgAfter = [CcHub.U]::GetForegroundWindow()
Write-Output ("attach=" + $attachOk + " setFg=" + $setFgOk + " fg-after=" + $fgAfter + " match=" + ($fgAfter -eq $hwnd))

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output "enter-sent"
`.trim();
}

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
   * Prefill + auto-press Enter — explicitly find a VSCode window and force-focus
   * it via Win32 P/Invoke before SendKeys, so the Enter cannot land on the
   * browser the user clicked "送出" from.
   *
   * Flow:
   *   1. Start-Process URI       → Windows dispatches to anthropic.claude-code
   *                                 extension, which opens/focuses the right tab
   *   2. Sleep delayMs           → let VSCode prefill the input box
   *   3. EnumWindows             → find top-level windows with title matching
   *                                 "Visual Studio Code"; prefer one whose
   *                                 title contains the workspace folder name
   *   4. AttachThreadInput trick → defeat foreground-stealing prevention so
   *                                 SetForegroundWindow actually works even
   *                                 though this PowerShell process is not fg
   *   5. SendKeys {ENTER}        → submitted to the now-focused VSCode panel
   */
  async prefillAndSubmit(
    sessionUuid: string | null,
    prompt: string,
    opts: { cwd?: string; delayMs?: number } = {},
  ): Promise<{ diag: string }> {
    if (process.platform !== "win32") {
      await this.send(sessionUuid, prompt);
      return { diag: "non-win32: prefill only, no SendKeys" };
    }
    const delayMs = opts.delayMs ?? 1000;
    // Workspace folder name hint for title matching.
    // "d:\code\cc-hub" → "cc-hub" ; "d:\code" → "code"
    const folderHint = (opts.cwd ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
    const parts: string[] = [];
    if (sessionUuid) parts.push(`session=${encodeURIComponent(sessionUuid)}`);
    parts.push(`prompt=${encodeURIComponent(prompt)}`);
    const url = `vscode://anthropic.claude-code/open?${parts.join("&")}`;
    const ps = buildFocusAndEnterPS(url, folderHint, delayMs);
    return new Promise<{ diag: string }>((resolve, reject) => {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-Command", ps],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c) => { stdout += c.toString(); });
      child.stderr?.on("data", (c) => { stderr += c.toString(); });
      child.on("exit", (code) => {
        const diag = `exit=${code} stdout=[${stdout.trim()}] stderr=[${stderr.trim()}]`;
        if (code === 0) resolve({ diag });
        else reject(new Error(`prefillAndSubmit ${diag}`));
      });
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
