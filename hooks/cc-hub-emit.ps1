# cc-hub hook emitter — invoked by ~/.claude/settings.json hooks
# Usage: cc-hub-emit.ps1 <event_type>
# Reads hook payload from stdin (Claude Code convention).
# Fails silently on any error to never block Claude.

param([Parameter(Mandatory)][string]$EventType)

$ErrorActionPreference = "SilentlyContinue"

try {
  $stdin = [Console]::In.ReadToEnd()
  $payload = $null
  if ($stdin) { $payload = $stdin | ConvertFrom-Json }

  # Resolve port (falls back to 8765 if port file missing)
  $portFile = Join-Path $HOME ".cc-hub\port"
  $port = 8765
  if (Test-Path $portFile) {
    $portFromFile = Get-Content $portFile -ErrorAction SilentlyContinue
    if ($portFromFile -match '^\d+$') { $port = [int]$portFromFile }
  }

  # Map Claude's event_type names to ours (validated in Task 3 spike)
  $typeMap = @{
    "SessionStart" = "session_start"
    "Stop" = "stop"
    "UserPromptSubmit" = "user_prompt"
    "PreToolUse" = "pre_tool_use"
    "PostToolUse" = "post_tool_use"
  }
  $ourType = $typeMap[$EventType]
  if (-not $ourType) { return }

  # Best-effort extraction — exact field names confirmed in spike doc
  $cwd = $payload.cwd
  if (-not $cwd) { $cwd = $env:CLAUDE_PROJECT_DIR }
  if (-not $cwd) { $cwd = (Get-Location).Path }

  $sessionId = $payload.session_id
  if (-not $sessionId) { $sessionId = $env:CLAUDE_SESSION_ID }

  $body = @{
    event_type = $ourType
    cwd = $cwd
    session_uuid = $sessionId
    timestamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress

  Invoke-RestMethod -Uri "http://127.0.0.1:$port/event" `
    -Method Post -Body $body -ContentType "application/json" `
    -TimeoutSec 2 | Out-Null
} catch {
  # swallow — never block Claude
}

exit 0
