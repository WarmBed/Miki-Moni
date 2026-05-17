<#
  miki-moni system-tray helper.

  Spawned by the daemon (src/index.ts) on Windows. Owns a NotifyIcon in the
  system tray for as long as the daemon process is alive — when the daemon
  PID disappears, this helper exits and the icon vanishes.

  Args:
    -DaemonPid <int>   PID to monitor. When it exits, this script exits too.
    -Port <int>        Daemon HTTP port (used by the "Open dashboard" menu).

  The cat icon is rendered at runtime via GDI+ — same path data as the SVG
  in web/assets/miki-cat.svg, just translated to GraphicsPath calls. No
  external icon file needed, so the daemon stays "single binary"-ish.
#>

param(
  [Parameter(Mandatory = $true)][int]$DaemonPid,
  [Parameter(Mandatory = $false)][int]$Port = 8765
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Render the sleeping-cat icon ────────────────────────────────────────
# SVG coords are in a 24×24 viewBox; we render to 32×32 (standard tray icon
# size) and rely on GDI+ antialiasing for the curves. GetHicon() returns an
# HICON that NotifyIcon can own; we wrap it in System.Drawing.Icon.
function New-CatIcon {
  $size = 32
  $scale = $size / 24.0
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $color = [System.Drawing.Color]::FromArgb(255, 28, 32, 36)
  $pen = New-Object System.Drawing.Pen $color, ([float](1.6 * $scale))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  function P([double]$x, [double]$y) {
    New-Object System.Drawing.PointF ([float]($x * $scale)), ([float]($y * $scale))
  }

  # ── Body + two ear peaks (one continuous closed path) ────────────────
  $body = New-Object System.Drawing.Drawing2D.GraphicsPath
  # M 4.5,13.2 → L peaks → close with Beziers
  $body.AddLine((P 4.5 13.2), (P 6 10))
  $body.AddLine((P 6 10),     (P 7.6 13))
  $body.AddLine((P 7.6 13),   (P 9.6 11))
  $body.AddLine((P 9.6 11),   (P 11.4 13))
  # C 14.5,13 18.5,13.6 20,15.8
  $body.AddBezier((P 11.4 13), (P 14.5 13),   (P 18.5 13.6), (P 20 15.8))
  # C 20.8,17 20.4,18.3 18.6,18.7
  $body.AddBezier((P 20 15.8), (P 20.8 17),   (P 20.4 18.3), (P 18.6 18.7))
  # C 16,19.2 7,19.2 5.4,18.4
  $body.AddBezier((P 18.6 18.7), (P 16 19.2), (P 7 19.2),    (P 5.4 18.4))
  # C 3.8,17.5 3.6,14.5 4.5,13.2
  $body.AddBezier((P 5.4 18.4),  (P 3.8 17.5), (P 3.6 14.5),  (P 4.5 13.2))
  $body.CloseFigure()
  $g.DrawPath($pen, $body)

  # ── Closed sleeping eye: q 0.9,0.7 1.8,0 starting at (6.8, 15.2) ─────
  # SVG quadratic q → endpoint at (6.8+1.8, 15.2+0) = (8.6, 15.2)
  # Convert quadratic Bezier (P0, C, P2) to cubic for GDI+:
  #   CP1 = P0 + 2/3 (C - P0); CP2 = P2 + 2/3 (C - P2)
  # P0=(6.8,15.2)  C=(7.7,15.9)  P2=(8.6,15.2)
  $eyePen = New-Object System.Drawing.Pen $color, ([float](1.3 * $scale))
  $eyePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $eyePen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $eye = New-Object System.Drawing.Drawing2D.GraphicsPath
  # CP1 = (6.8 + 2/3*(7.7-6.8), 15.2 + 2/3*(15.9-15.2)) = (7.4, 15.667)
  # CP2 = (8.6 + 2/3*(7.7-8.6), 15.2 + 2/3*(15.9-15.2)) = (8.0, 15.667)
  $eye.AddBezier((P 6.8 15.2), (P 7.4 15.667), (P 8.0 15.667), (P 8.6 15.2))
  $g.DrawPath($eyePen, $eye)

  # ── Two Z's drifting up: each is "h L h" — three line segments ──────
  $zPen1 = New-Object System.Drawing.Pen $color, ([float](1.3 * $scale))
  $zPen1.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $zPen1.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $zPen1.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $z1 = New-Object System.Drawing.Drawing2D.GraphicsPath
  # M 15,7  h 2.4  l -2.4,2.6  h 2.4  →  (15,7)→(17.4,7)→(15,9.6)→(17.4,9.6)
  $z1.AddLine((P 15 7),     (P 17.4 7))
  $z1.AddLine((P 17.4 7),   (P 15 9.6))
  $z1.AddLine((P 15 9.6),   (P 17.4 9.6))
  $g.DrawPath($zPen1, $z1)

  $zPen2 = New-Object System.Drawing.Pen $color, ([float](1.1 * $scale))
  $zPen2.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $zPen2.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $zPen2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $z2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  # M 18.4,4.5  h 1.6  l -1.6,1.8  h 1.6  → (18.4,4.5)→(20,4.5)→(18.4,6.3)→(20,6.3)
  $z2.AddLine((P 18.4 4.5), (P 20 4.5))
  $z2.AddLine((P 20 4.5),   (P 18.4 6.3))
  $z2.AddLine((P 18.4 6.3), (P 20 6.3))
  $g.DrawPath($zPen2, $z2)

  $g.Dispose()
  $hicon = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($hicon)
  return @{ Icon = $icon; Bitmap = $bmp; Handle = $hicon }
}

# ── Build the NotifyIcon ────────────────────────────────────────────────
$catIcon = New-CatIcon
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $catIcon.Icon
$notify.Text = "miki-moni · running · pid $DaemonPid"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem    = $menu.Items.Add("Open dashboard")
$pairItem    = $menu.Items.Add("Show pairing QR")
$restartItem = $menu.Items.Add("Restart daemon")
$null = $menu.Items.Add("-")  # separator
$quitItem    = $menu.Items.Add("Quit daemon")

$openItem.Add_Click({
  Start-Process "http://127.0.0.1:$Port" | Out-Null
})

# Read pair_token + worker_url + phone_pwa_url from config.json and open the
# static pair-info.html page that the daemon serves out of dist/web/. The page
# renders the QR in-browser, no server endpoint needed.
$pairItem.Add_Click({
  try {
    $cfgPath = Join-Path $env:USERPROFILE ".miki-moni\config.json"
    if (-not (Test-Path $cfgPath)) {
      [System.Windows.Forms.MessageBox]::Show(
        "config.json not found at $cfgPath. Run ``miki setup`` first.",
        "miki-moni", "OK", "Warning") | Out-Null
      return
    }
    $cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json
    $token = $cfg.remote.pair_token
    $relay = $cfg.remote.worker_url
    $pwa   = if ($cfg.remote.phone_pwa_url) { $cfg.remote.phone_pwa_url } else { "https://miki-moni.pages.dev/" }
    if (-not $token -or -not $relay) {
      [System.Windows.Forms.MessageBox]::Show(
        "No pair_token or worker_url in config. Run ``miki pair`` to create one.",
        "miki-moni", "OK", "Warning") | Out-Null
      return
    }
    Add-Type -AssemblyName System.Web
    $q = "t=" + [System.Web.HttpUtility]::UrlEncode($token) +
         "&r=" + [System.Web.HttpUtility]::UrlEncode($relay) +
         "&pwa=" + [System.Web.HttpUtility]::UrlEncode($pwa)
    Start-Process "http://127.0.0.1:$Port/pair-info.html?$q" | Out-Null
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "Could not open pairing page: $_",
      "miki-moni", "OK", "Error") | Out-Null
  }
})

$restartItem.Add_Click({
  # POST /admin/restart so the daemon can decide how to relaunch itself.
  # Best-effort: fire and forget; if the endpoint doesn't exist we just
  # exit and rely on `miki claude` to respawn on next use.
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/admin/restart" `
      -Method Post -UseBasicParsing -TimeoutSec 2 | Out-Null
  } catch { }
})

$quitItem.Add_Click({
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/admin/quit" `
      -Method Post -UseBasicParsing -TimeoutSec 2 | Out-Null
  } catch { }
  # If the daemon ignored /admin/quit, fall back to killing the PID directly.
  Start-Sleep -Milliseconds 800
  if (Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $DaemonPid -Force -ErrorAction SilentlyContinue
  }
})

# Single-click also opens the dashboard — matches most tray-app conventions.
$notify.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Start-Process "http://127.0.0.1:$Port" | Out-Null
  }
})
$notify.ContextMenuStrip = $menu

# ── PID watcher: poll once per second; when daemon dies, we die too ────
# A WinForms Timer fires on the UI thread so we can touch $notify safely.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  if (-not (Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue)) {
    $timer.Stop()
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

# Run the WinForms message pump. Application.Exit() above breaks out cleanly.
try {
  [System.Windows.Forms.Application]::Run()
}
finally {
  $timer.Stop()
  if ($notify) { $notify.Visible = $false; $notify.Dispose() }
  if ($catIcon.Icon) { $catIcon.Icon.Dispose() }
  if ($catIcon.Bitmap) { $catIcon.Bitmap.Dispose() }
}
