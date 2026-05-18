# Migration Runbook — `f1telemetrystationpro.org` → `f1telemetrystationpro.org`

> Companion to `2026-05-18-migrate-hosted-relay-to-f1telemetrystationpro.md`. Self-contained executable script form. Copy-paste each block in PowerShell from repo root (`D:\code\cc-hub`).

## Status snapshot (2026-05-18 01:05)

| # | Task | Status |
|---|---|---|
| 1 | Pre-flight | ✅ done — stash `pre-f1telemetrystationpro-migration` created |
| 2 | Dual-host wrangler deploy | ✅ done — commit `6ce2738` |
| 3 | Verify dual-host (automated) | ✅ done — both `/v1/health` → 200, SSL OK |
| 4 | Hard checkpoint | ✅ user gave GO (E2 path, skipped manual E2E) |
| 5 | Replace source strings | 🟡 partial — only `tests/pairing.test.ts` updated (uncommitted); 9 other files pending |
| 6–15 | Docs / worktree / push / detach / filter-repo / npm | ⬜ pending |

---

## Block A — Finish Task 5: replace source strings (idempotent)

PowerShell from repo root. Re-runnable: pre-replaced files become no-ops.

```powershell
# Files to edit (production source + test fixture)
$files = @(
  "tests\pairing.test.ts",
  "worker\wrangler.toml",
  "web-phone\main-tunnel.tsx",
  "web-phone\store.ts",
  "src\cli\setup-wizard.ts",
  "src\cli\setup-self-host.ts",
  "src\cli\pair.ts",
  "src\cli\i18n-cli.ts",
  "src\relay-client.ts"
)

foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Warning "missing: $f"; continue }
  $content = Get-Content -Raw -Encoding UTF8 $f
  $new = $content `
    -replace "relay\.f1telemetrystationpro\.ai", "relay.f1telemetrystationpro.org" `
    -replace "cch\.f1telemetrystationpro\.ai",   "relay.f1telemetrystationpro.org" `
    -replace "f1telemetrystationpro\.ai",        "f1telemetrystationpro.org" `
    -replace "f1telemetrystationpro",            "f1telemetrystationpro"
  if ($new -ne $content) {
    # Preserve original line endings (Windows mostly CRLF)
    [System.IO.File]::WriteAllText((Resolve-Path $f), $new, [System.Text.UTF8Encoding]::new($false))
    Write-Host "edited: $f"
  } else {
    Write-Host "unchanged: $f"
  }
}

# Drop the old route from wrangler.toml (regex on the line)
$wtoml = Get-Content -Raw -Encoding UTF8 "worker\wrangler.toml"
$wtoml2 = $wtoml -replace "(?m)^\s*\{\s*pattern\s*=\s*`"relay\.f1telemetrystationpro\.com`"[^}]*\},?\s*\r?\n", ""
# (the dual-route block becomes single-route; verify visually after)
# Easier approach: rewrite the whole routes block:
$wtoml = Get-Content -Raw -Encoding UTF8 "worker\wrangler.toml"
$newBlock = @"
routes = [
  { pattern = "relay.f1telemetrystationpro.org", custom_domain = true }
]
"@
# Match the multi-line routes block (current has 2 entries after Task 2)
$wtomlNew = [regex]::Replace($wtoml, "(?s)routes\s*=\s*\[[^\]]*\]", $newBlock)
if ($wtomlNew -ne $wtoml) {
  [System.IO.File]::WriteAllText((Resolve-Path "worker\wrangler.toml"), $wtomlNew, [System.Text.UTF8Encoding]::new($false))
  Write-Host "wrangler.toml: dropped old route"
}
```

### Verify

```powershell
# Grep for any remaining f1telemetrystationpro in scoped paths (should be empty)
Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.toml -Path src,web-phone,worker,tests `
  | Select-String -Pattern "f1telemetrystationpro" -List

# Run tests + typecheck
pnpm typecheck
pnpm test
```

Expected: grep prints nothing; both `pnpm` commands exit 0.

### Commit

```powershell
git add tests/pairing.test.ts worker/wrangler.toml web-phone/main-tunnel.tsx web-phone/store.ts `
        src/cli/setup-wizard.ts src/cli/setup-self-host.ts src/cli/pair.ts `
        src/cli/i18n-cli.ts src/relay-client.ts
git commit -m "chore: switch hosted relay domain to relay.f1telemetrystationpro.org"
```

---

## Block B — Task 6: docs replacement

```powershell
$docs = @("README.md", "README.zh-TW.md", "README.zh-CN.md", "docs\deploy.md")
foreach ($f in $docs) {
  $c = Get-Content -Raw -Encoding UTF8 $f
  $n = $c `
    -replace "relay\.f1telemetrystationpro\.ai", "relay.f1telemetrystationpro.org" `
    -replace "cch\.f1telemetrystationpro\.ai",   "relay.f1telemetrystationpro.org" `
    -replace "f1telemetrystationpro\.ai",        "f1telemetrystationpro.org" `
    -replace "f1telemetrystationpro",            "f1telemetrystationpro"
  if ($n -ne $c) {
    [System.IO.File]::WriteAllText((Resolve-Path $f), $n, [System.Text.UTF8Encoding]::new($false))
    Write-Host "edited: $f"
  }
}

# Verify
Get-ChildItem README*.md, docs/deploy.md | Select-String "f1telemetrystationpro" -List

git add README.md README.zh-TW.md README.zh-CN.md docs/deploy.md
git commit -m "docs: update README and deploy guide to relay.f1telemetrystationpro.org"
```

---

## Block C — Task 7: clean worktree

```powershell
# Inspect
git worktree list
git -C .claude/worktrees/feat+codex-support log -1 --oneline
git -C .claude/worktrees/feat+codex-support status -s

# Decision: is worktree-feat+codex-support branch worth keeping?
git log --oneline main..worktree-feat+codex-support 2>&1
```

If output shows commits that aren't on main → **Block C.1 (replace strings on branch)**:

```powershell
Push-Location .claude\worktrees\feat+codex-support
$wfiles = git ls-files | Where-Object { $_ -match "\.(ts|tsx|md|toml)$" }
foreach ($f in $wfiles) {
  $c = Get-Content -Raw -Encoding UTF8 $f
  $n = $c `
    -replace "relay\.f1telemetrystationpro\.ai", "relay.f1telemetrystationpro.org" `
    -replace "cch\.f1telemetrystationpro\.ai",   "relay.f1telemetrystationpro.org" `
    -replace "f1telemetrystationpro\.ai",        "f1telemetrystationpro.org" `
    -replace "f1telemetrystationpro",            "f1telemetrystationpro"
  if ($n -ne $c) {
    [System.IO.File]::WriteAllText((Resolve-Path $f), $n, [System.Text.UTF8Encoding]::new($false))
  }
}
git add -A
git commit -m "chore: switch hosted relay domain to relay.f1telemetrystationpro.org"
Pop-Location
```

If branch is stale → **Block C.2 (remove worktree)**:

```powershell
git worktree remove .claude\worktrees\feat+codex-support --force
git branch -D worktree-feat+codex-support
```

### Final cross-tree verification

```powershell
Get-ChildItem -Recurse -File -Exclude *.log `
  | Where-Object { $_.FullName -notmatch "node_modules|\.git\\" -and $_.FullName -notmatch "docs\\superpowers\\(specs|plans)\\2026-05-18-migrate" } `
  | Select-String "f1telemetrystationpro" -List
```

Expected: only matches inside historical `docs/superpowers/{specs,plans}/2026-05-17-*` — those get rewritten by filter-repo in Block E.

---

## Block D — Task 8 + 9: push and detach

```powershell
# Task 8: push clean tree
git push origin main

# Task 9: deploy with single-host (wrangler.toml already updated in Block A)
cd worker
npx wrangler deploy
cd ..

# Verify old endpoint detached
curl.exe -sI -m 10 https://relay.f1telemetrystationpro.org/v1/health
# Expected: NOT 200 (no route / SSL hostname mismatch)
curl.exe -sI -m 10 https://relay.f1telemetrystationpro.org/v1/health
# Expected: HTTP 200
```

### Manual step 9.3 (you must click)

Open **https://dash.cloudflare.com/f566818c6e44ffc818fdd420d8697959/f1telemetrystationpro.org/dns/records** and:
- Delete the `relay` DNS record on `f1telemetrystationpro.org` zone (or set proxy=grey if F1TelemetryStationPro site needs the name).

This severs the final public f1telemetrystationpro ↔ Miki-Moni link.

---

## Block E — Tasks 10–12: history rewrite + force push

### E.0 — Install git-filter-repo

```powershell
git filter-repo --version
# If "not a git command":
pip install git-filter-repo
git filter-repo --version
```

### E.1 — Mirror clone

```powershell
cd D:\code
git clone --no-local --mirror cc-hub cc-hub-rewrite.git
cd cc-hub-rewrite.git
```

### E.2 — Replacement spec

```powershell
@"
relay.f1telemetrystationpro.org==>relay.f1telemetrystationpro.org
relay.f1telemetrystationpro.org==>relay.f1telemetrystationpro.org
f1telemetrystationpro.org==>f1telemetrystationpro.org
f1telemetrystationpro==>f1telemetrystationpro
"@ | Out-File -FilePath D:\code\replace-f1telemetrystationpro.txt -Encoding ascii -NoNewline
```

### E.3 — Rewrite blobs

```powershell
git filter-repo --replace-text D:\code\replace-f1telemetrystationpro.txt --force
```

### E.4 — Rewrite the offending commit message

```powershell
git filter-repo --message-callback 'return message.replace(b"f1telemetrystationpro", b"f1telemetrystationpro")' --force
```

### E.5 — Verify history clean

```powershell
$hits = git log --all -p | Select-String "f1telemetrystationpro" -SimpleMatch
$msgs = git log --all --format='%s%n%b' | Select-String "f1telemetrystationpro" -SimpleMatch
Write-Host "blob hits: $($hits.Count)"
Write-Host "msg hits:  $($msgs.Count)"
# Both must be 0.
```

### E.6 — 🚦 LAST CHANCE TO ABORT 🚦

Before this push, the mirror is rewritten but GitHub still has original history. **Press Ctrl+C now if you want to stop.**

### E.7 — Force push

```powershell
git remote -v   # confirm origin = github.com/WarmBed/Miki-Moni.git
git push --force --all
git push --force --tags
```

### E.8 — Sync local working clone

```powershell
cd D:\code\cc-hub
git fetch --all --prune
git reset --hard origin/main
git gc --prune=now --aggressive
git log --all -p | Select-String "f1telemetrystationpro" -SimpleMatch | Measure-Object | Select-Object -ExpandProperty Count
# Expected: 0
```

---

## Block F — Tasks 13 + 14: npm wipe and republish

### F.0 — Confirm npm auth

```powershell
npm whoami
# If empty: npm login
```

### F.1 — 🚦 LAST CHANCE TO ABORT 🚦

The next 4 commands wipe all published versions of `miki-moni`. Within the 72h grace window all 4 (`0.1.0`, `0.2.1`, `0.2.6`, `0.3.0`) are eligible.

### F.2 — Unpublish

```powershell
npm unpublish miki-moni@0.1.0 --force
npm unpublish miki-moni@0.2.1 --force
npm unpublish miki-moni@0.2.6 --force
npm unpublish miki-moni@0.3.0 --force
```

### F.3 — Verify removal

```powershell
curl.exe -s https://registry.npmjs.org/miki-moni | python -c "import sys, json; d=json.load(sys.stdin); print('versions:', list(d.get('versions',{}).keys()))"
# Expected: empty list, or "Not Found"
```

### F.4 — Bump and rebuild

```powershell
npm version patch --no-git-tag-version   # → 0.3.1
pnpm install
pnpm build:all
pnpm test
pnpm typecheck
```

### F.5 — Pack-and-verify tarball is clean

```powershell
npm pack
# Expand and grep
Expand-Archive -Path .\miki-moni-0.3.1.tgz -DestinationPath .\_tarcheck -Force 2>$null
if (-not $?) {
  # tgz may need tar instead
  tar -xzf miki-moni-0.3.1.tgz -C _tarcheck
}
$tarhits = Get-ChildItem _tarcheck -Recurse -File | Select-String "f1telemetrystationpro" -SimpleMatch | Measure-Object | Select-Object -ExpandProperty Count
Write-Host "tarball f1telemetrystationpro hits: $tarhits"
# Expected: 0
Remove-Item -Recurse -Force _tarcheck, miki-moni-0.3.1.tgz
```

### F.6 — Publish

```powershell
npm publish --access public
```

### F.7 — Commit version bump

```powershell
git add package.json pnpm-lock.yaml
git commit -m "chore(release): 0.3.1 — clean republish on relay.f1telemetrystationpro.org"
git tag v0.3.1
git push origin main --tags
```

---

## Block G — Task 15: final cross-surface verification

```powershell
# GitHub repo search (may lag 24h after force-push)
gh api -X GET search/code -f q="f1telemetrystationpro repo:WarmBed/Miki-Moni" --jq '.total_count'
# Expected: 0

# npm registry
curl.exe -s https://registry.npmjs.org/miki-moni | Select-String "f1telemetrystationpro" | Measure-Object | Select-Object -ExpandProperty Count
# Expected: 0

# Relays
curl.exe -sI -m 10 https://relay.f1telemetrystationpro.org/v1/health   # 200
curl.exe -sI -m 10 https://relay.f1telemetrystationpro.org/v1/health    # NOT 200

# Restore stash
git stash list
git stash pop   # if Task 1 stashed work
```

---

## Done summary template

```
Migration complete.
- main tree, history, npm: zero f1telemetrystationpro references
- relay.f1telemetrystationpro.org: serving traffic
- relay.f1telemetrystationpro.org: detached and DNS removed
- miki-moni@0.3.1 published, prior versions unpublished
- Residual: 1 commit-message reference in gharchive.org event log (unfixable, low-risk)
```
