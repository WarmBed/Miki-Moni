/**
 * PowerShell script that:
 *   1. Sets clipboard to the prompt text (UTF-8 base64-encoded to avoid PS quoting bugs)
 *   2. Finds a VSCode top-level window (prefers title containing `folderHint`)
 *   3. Force-foregrounds it via Win32 P/Invoke (ALT keypress + AttachThreadInput
 *      + SetForegroundWindow + SwitchToThisWindow — defeats Win10/11 fg lock)
 *   4. SendKeys ^a then {DELETE} to clear any leftover input text
 *   5. SendKeys ^v to paste the prompt from clipboard
 *   6. Brief settle, then SendKeys {ENTER} to submit
 *   7. Restores prior clipboard contents (best-effort)
 *
 * Clipboard paste path is chosen over passing the prompt through the URI /
 * primaryEditor.open command arg because claude-code IGNORES the prompt arg
 * when the session is already open (shows "Session is already open. Your
 * prompt was not applied — enter it manually."). That breaks the 2nd send
 * to any session and pops up a noisy notification. With clipboard paste we
 * sidestep that path entirely and reliably deliver to whichever input has
 * keyboard focus after claude-vscode.focus.
 *
 * The `'@` here-string terminator MUST be at column 0.
 */
export function buildFocusAndEnterPS(opts: { folderHint: string; prompt: string }): string {
  const h = opts.folderHint.replace(/'/g, "''");
  // Base64 keeps the PS source free of any quoting / newline / backtick edge
  // case in the user's prompt — we just decode at runtime inside PS.
  const promptB64 = Buffer.from(opts.prompt, "utf8").toString("base64");
  return `
$ErrorActionPreference = 'Stop'

# Stash existing clipboard so we restore it after our paste (the user may have
# copied something they care about). Best-effort; if it fails we proceed.
$savedClip = $null
try { $savedClip = Get-Clipboard -Raw -ErrorAction Stop } catch {}

# Decode our prompt from base64 (avoids ALL quoting / newline / backtick edge cases).
$promptBytes = [System.Convert]::FromBase64String('${promptB64}')
$promptText  = [System.Text.Encoding]::UTF8.GetString($promptBytes)
Set-Clipboard -Value $promptText

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
Add-Type -MemberDefinition $sig -Name 'U' -Namespace 'MikiMoniHelper'

$candidates = New-Object System.Collections.ArrayList
$proc = [MikiMoniHelper.U+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  if (-not [MikiMoniHelper.U]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [MikiMoniHelper.U]::GetWindowText($h, $sb, 512) | Out-Null
  $title = $sb.ToString()
  if ($title -match 'Visual Studio Code') {
    [void]$candidates.Add(@{ Hwnd = $h; Title = $title })
  }
  return $true
}
[MikiMoniHelper.U]::EnumWindows($proc, [IntPtr]::Zero) | Out-Null

$best = $null
$hint = '${h}'
if ($hint -ne '') {
  $best = $candidates | Where-Object { $_.Title -match [regex]::Escape($hint) } | Select-Object -First 1
}
if (-not $best) {
  $fg = [MikiMoniHelper.U]::GetForegroundWindow()
  $best = $candidates | Where-Object { $_.Hwnd -eq $fg } | Select-Object -First 1
}
if (-not $best -and $candidates.Count -gt 0) { $best = $candidates[0] }

Write-Output ("candidates=" + $candidates.Count)
foreach ($c in $candidates) { Write-Output ("  cand hwnd=" + $c.Hwnd + " title=" + $c.Title) }

if (-not $best) {
  Write-Error ("No VSCode window found (candidates: " + $candidates.Count + ")")
  exit 2
}

$fgBefore = [MikiMoniHelper.U]::GetForegroundWindow()
$hwnd = $best.Hwnd
Write-Output ("picked hwnd=" + $hwnd + " title=" + $best.Title)
Write-Output ("fg-before hwnd=" + $fgBefore)

if ([MikiMoniHelper.U]::IsIconic($hwnd)) { [MikiMoniHelper.U]::ShowWindow($hwnd, 9) | Out-Null }

[MikiMoniHelper.U]::LockSetForegroundWindow(2) | Out-Null
[MikiMoniHelper.U]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[MikiMoniHelper.U]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
Start-Sleep -Milliseconds 30

$targetTid = [MikiMoniHelper.U]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$myTid     = [MikiMoniHelper.U]::GetCurrentThreadId()
$attachOk  = [MikiMoniHelper.U]::AttachThreadInput($myTid, $targetTid, $true)
$setFgOk   = [MikiMoniHelper.U]::SetForegroundWindow($hwnd)
[MikiMoniHelper.U]::BringWindowToTop($hwnd) | Out-Null
[MikiMoniHelper.U]::SwitchToThisWindow($hwnd, $true)
[MikiMoniHelper.U]::AttachThreadInput($myTid, $targetTid, $false) | Out-Null
Start-Sleep -Milliseconds 200

$fgAfter = [MikiMoniHelper.U]::GetForegroundWindow()
Write-Output ("attach=" + $attachOk + " setFg=" + $setFgOk + " fg-after=" + $fgAfter + " match=" + ($fgAfter -eq $hwnd))

Add-Type -AssemblyName System.Windows.Forms

# Clear leftover input, paste the new prompt from clipboard, then submit.
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 30
[System.Windows.Forms.SendKeys]::SendWait('{DELETE}')
Start-Sleep -Milliseconds 30
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output "enter-sent"

# Restore prior clipboard contents (best-effort).
if ($savedClip -ne $null) {
  Start-Sleep -Milliseconds 50
  try { Set-Clipboard -Value $savedClip } catch {}
}
`.trim();
}
