/**
 * PowerShell script: find a VSCode top-level window (prefer one whose title
 * contains `folderHint`), force it to OS foreground via Win32 P/Invoke
 * (LockSetForegroundWindow unlock + ALT keypress + AttachThreadInput +
 * SetForegroundWindow + SwitchToThisWindow), then SendKeys {ENTER}.
 *
 * This is a variant of cc-hub/src/vscode-bridge.ts:buildFocusAndEnterPS with
 * the `Start-Process vscode://...` step removed — the extension already fired
 * the URI in-process via vscode.env.openExternal, so there's nothing to launch.
 *
 * The `'@` here-string terminator MUST be at column 0 — the function builds
 * the script without leading whitespace on that line.
 */
export function buildFocusAndEnterPS(opts: { folderHint: string }): string {
  const h = opts.folderHint.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'

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
Add-Type -MemberDefinition $sig -Name 'U' -Namespace 'CcHubHelper'

$candidates = New-Object System.Collections.ArrayList
$proc = [CcHubHelper.U+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  if (-not [CcHubHelper.U]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [CcHubHelper.U]::GetWindowText($h, $sb, 512) | Out-Null
  $title = $sb.ToString()
  if ($title -match 'Visual Studio Code') {
    [void]$candidates.Add(@{ Hwnd = $h; Title = $title })
  }
  return $true
}
[CcHubHelper.U]::EnumWindows($proc, [IntPtr]::Zero) | Out-Null

$best = $null
$hint = '${h}'
if ($hint -ne '') {
  $best = $candidates | Where-Object { $_.Title -match [regex]::Escape($hint) } | Select-Object -First 1
}
if (-not $best) {
  $fg = [CcHubHelper.U]::GetForegroundWindow()
  $best = $candidates | Where-Object { $_.Hwnd -eq $fg } | Select-Object -First 1
}
if (-not $best -and $candidates.Count -gt 0) { $best = $candidates[0] }

Write-Output ("candidates=" + $candidates.Count)
foreach ($c in $candidates) { Write-Output ("  cand hwnd=" + $c.Hwnd + " title=" + $c.Title) }

if (-not $best) {
  Write-Error ("No VSCode window found (candidates: " + $candidates.Count + ")")
  exit 2
}

$fgBefore = [CcHubHelper.U]::GetForegroundWindow()
$hwnd = $best.Hwnd
Write-Output ("picked hwnd=" + $hwnd + " title=" + $best.Title)
Write-Output ("fg-before hwnd=" + $fgBefore)

if ([CcHubHelper.U]::IsIconic($hwnd)) { [CcHubHelper.U]::ShowWindow($hwnd, 9) | Out-Null }

[CcHubHelper.U]::LockSetForegroundWindow(2) | Out-Null
[CcHubHelper.U]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[CcHubHelper.U]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
Start-Sleep -Milliseconds 30

$targetTid = [CcHubHelper.U]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$myTid     = [CcHubHelper.U]::GetCurrentThreadId()
$attachOk  = [CcHubHelper.U]::AttachThreadInput($myTid, $targetTid, $true)
$setFgOk   = [CcHubHelper.U]::SetForegroundWindow($hwnd)
[CcHubHelper.U]::BringWindowToTop($hwnd) | Out-Null
[CcHubHelper.U]::SwitchToThisWindow($hwnd, $true)
[CcHubHelper.U]::AttachThreadInput($myTid, $targetTid, $false) | Out-Null
Start-Sleep -Milliseconds 200

$fgAfter = [CcHubHelper.U]::GetForegroundWindow()
Write-Output ("attach=" + $attachOk + " setFg=" + $setFgOk + " fg-after=" + $fgAfter + " match=" + ($fgAfter -eq $hwnd))

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output "enter-sent"
`.trim();
}
