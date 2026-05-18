# Migrate Hosted Relay to f1telemetrystationpro.org — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `f1telemetrystationpro.org` with `f1telemetrystationpro.org` as the hosted-relay domain across cc-hub repo, git history, and npm — with a verified non-breaking cutover.

**Architecture:** Two-phase migration. **Phase A** (Tasks 1–4) is additive and reversible: stand up `relay.f1telemetrystationpro.org` alongside the existing `relay.f1telemetrystationpro.org` Worker route, verify, then HARD CHECKPOINT for user approval. **Phase B** (Tasks 5–14) is irreversible: working-tree replacement, route teardown, `git filter-repo` history rewrite, force-push, and `npm unpublish --force` + clean republish.

**Tech Stack:** Cloudflare Workers / Durable Objects, `wrangler` CLI, `git filter-repo`, `pnpm`, `npm`, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-18-migrate-hosted-relay-to-f1telemetrystationpro.md` (status: Approved 2026-05-18)

**Affected files inventory** (grep `f1telemetrystationpro|cch\.` 2026-05-18, main tree only — worktree handled in Task 7):
- `worker/wrangler.toml`
- `web-phone/main-tunnel.tsx`
- `web-phone/store.ts`
- `src/cli/setup-wizard.ts`
- `src/cli/setup-self-host.ts`
- `src/cli/pair.ts`
- `src/cli/i18n-cli.ts`
- `src/relay-client.ts`
- `tests/pairing.test.ts`
- `README.md`, `README.zh-TW.md`, `README.zh-CN.md`
- `docs/deploy.md`

**Pre-flight environment assumed:** `npx wrangler whoami` returns the CF account `f566818c6e44ffc818fdd420d8697959`; `f1telemetrystationpro.org` zone exists in that account; `npm whoami` returns the publisher of `miki-moni`; Python 3 and `git filter-repo` (or `pip install git-filter-repo`) are available.

---

## PHASE A — Stand Up New Relay (Additive, Reversible)

### Task 1: Pre-flight checks

**Files:** none (verification only)

- [ ] **Step 1.1: Confirm CF auth and target account**

```bash
npx wrangler whoami
```

Expected: account ID `f566818c6e44ffc818fdd420d8697959` listed.

- [ ] **Step 1.2: Confirm f1telemetrystationpro.org zone is in the account**

```bash
curl -s -H "Authorization: Bearer $(node -e "
const fs=require('fs');const p=require('path');const os=require('os');
const cfg=p.join(os.homedir(),'AppData','Roaming','xdg.config','.wrangler','config','default.toml');
const t=fs.readFileSync(cfg,'utf8');
const m=t.match(/oauth_token\s*=\s*\"([^\"]+)\"/);
console.log(m?m[1]:'');")" \
"https://api.cloudflare.com/client/v4/zones?name=f1telemetrystationpro.org" | python -c "import json,sys; d=json.load(sys.stdin); print([z['id'] for z in d['result']])"
```

Expected: a single zone ID printed (non-empty list). If empty, STOP — add the zone to CF before proceeding.

- [ ] **Step 1.3: Confirm clean working tree (or stash unrelated changes)**

```bash
git status -s
```

Expected: no `f1telemetrystationpro`-related files modified. The unrelated test/web/package files visible from prior work should be stashed (`git stash -u`) before continuing so this plan's commits stay scoped:

```bash
git stash push -u -m "pre-f1telemetrystationpro-migration"
```

- [ ] **Step 1.4: Verify current relay still healthy (baseline)**

```bash
curl -sI https://relay.f1telemetrystationpro.org/v1/health
```

Expected: HTTP 200. Record the response for comparison.

- [ ] **Step 1.5: Commit (none — verification only). Proceed to Task 2.**

---

### Task 2: Add `relay.f1telemetrystationpro.org` DNS + dual-host Worker route

**Files:**
- Modify: `worker/wrangler.toml` (add second route entry)

- [ ] **Step 2.1: Add DNS record in CF dashboard**

Manual action (CF dashboard → f1telemetrystationpro.org → DNS → Records):

- Type: `AAAA`, Name: `relay`, Content: `100::` (placeholder — required for Workers custom-domain proxying), Proxy: **on (orange)**.
- Alternatively use `A` record with `192.0.2.1` (also a placeholder; Worker custom domains override the record).

Expected: record appears in DNS list.

- [ ] **Step 2.2: Add second route in `worker/wrangler.toml`**

Replace the current `routes` block:

```toml
routes = [
  { pattern = "relay.f1telemetrystationpro.org", custom_domain = true }
]
```

With:

```toml
routes = [
  { pattern = "relay.f1telemetrystationpro.org", custom_domain = true },
  { pattern = "relay.f1telemetrystationpro.org", custom_domain = true }
]
```

- [ ] **Step 2.3: Deploy the Worker**

```bash
cd worker
npx wrangler deploy
cd ..
```

Expected: wrangler reports both custom domains attached (`relay.f1telemetrystationpro.org` AND `relay.f1telemetrystationpro.org`). The first deploy provisioning SSL for the new domain can take 1–3 minutes.

- [ ] **Step 2.4: Commit the wrangler.toml change only**

```bash
git add worker/wrangler.toml
git commit -m "chore(worker): add relay.f1telemetrystationpro.org custom domain (dual-host transition)"
```

---

### Task 3: Verify dual-host relay end-to-end

**Files:** none (verification only)

- [ ] **Step 3.1: Health check both endpoints**

```bash
curl -sI https://relay.f1telemetrystationpro.org/v1/health
curl -sI https://relay.f1telemetrystationpro.org/v1/health
```

Expected: both return HTTP 200. If `f1telemetrystationpro` returns 526 / 522 / SSL error, wait 2 minutes and retry — CF SSL provisioning is in progress.

- [ ] **Step 3.2: Confirm Worker source identity**

```bash
curl -s https://relay.f1telemetrystationpro.org/v1/health
curl -s https://relay.f1telemetrystationpro.org/v1/health
```

Expected: identical body (e.g. `ok`).

- [ ] **Step 3.3: Manual pairing E2E against new host (no code changes yet)**

Start the daemon pointed at the new host temporarily via env override:

```bash
$env:MIKI_RELAY_URL = "wss://relay.f1telemetrystationpro.org"
pnpm dev
```

In a second terminal pair:

```bash
pnpm pair --new --worker-url=wss://relay.f1telemetrystationpro.org
```

Expected: pairing token printed, QR / URL generated, phone PWA (browser) successfully connects when scanning. Tear the daemon down with Ctrl+C.

- [ ] **Step 3.4: Commit (none — verification only).**

---

### Task 4: 🚦 HARD CHECKPOINT — user approves cutover

**Files:** none

- [ ] **Step 4.1: Print verification summary to user**

```
Phase A complete:
- relay.f1telemetrystationpro.org → 200 OK (still serving)
- relay.f1telemetrystationpro.org → 200 OK
- Manual pairing E2E on relay.f1telemetrystationpro.org: PASS
- Worker deployed with both custom-domain bindings
- 1 commit on main (wrangler.toml dual-host)
```

- [ ] **Step 4.2: STOP. Do not begin Task 5 until the user explicitly approves cutover.**

Wait for user message like "OK cut over" / "go" / "phase B". Phase B is irreversible (history rewrite + npm unpublish). If the user wants to roll back instead:

```bash
# Rollback: remove the new route, redeploy
# Edit worker/wrangler.toml back to single-route, then:
cd worker && npx wrangler deploy && cd ..
# Then in CF dashboard, delete the relay.f1telemetrystationpro.org DNS record.
```

---

## PHASE B — Cut Over and Erase (Irreversible)

### Task 5: Replace `f1telemetrystationpro` in production source files (test-first where applicable)

**Files:**
- Modify: `tests/pairing.test.ts`
- Modify: `worker/wrangler.toml`
- Modify: `web-phone/main-tunnel.tsx`
- Modify: `web-phone/store.ts`
- Modify: `src/cli/setup-wizard.ts`
- Modify: `src/cli/setup-self-host.ts`
- Modify: `src/cli/pair.ts`
- Modify: `src/cli/i18n-cli.ts`
- Modify: `src/relay-client.ts`

- [ ] **Step 5.1: Update test fixture to assert new domain (failing test)**

Open `tests/pairing.test.ts`. Locate the two occurrences at lines 97 and 104 and replace:

```ts
// before
worker_url: "https://relay.f1telemetrystationpro.org",
// after
worker_url: "https://relay.f1telemetrystationpro.org",
```

```ts
// before
expect(payload).toContain("r=https%3A%2F%2Frelay.f1telemetrystationpro.org");
// after
expect(payload).toContain("r=https%3A%2F%2Frelay.f1telemetrystationpro.org");
```

- [ ] **Step 5.2: Run the test — expect failure (because source still emits f1telemetrystationpro)**

```bash
pnpm test -- tests/pairing.test.ts
```

Expected: pairing test FAILS with mismatch showing `relay.f1telemetrystationpro.org` in actual vs `relay.f1telemetrystationpro.org` in expected. This proves the test guards the new contract.

- [ ] **Step 5.3: Update `src/cli/setup-wizard.ts`**

Change line 20:

```ts
// before
const HOSTED_RELAY_URL = "wss://relay.f1telemetrystationpro.org";
// after
const HOSTED_RELAY_URL = "wss://relay.f1telemetrystationpro.org";
```

And line 4 comment:

```ts
//   1. Hosted (default, recommended)   — use relay.f1telemetrystationpro.org. Zero setup.
```

- [ ] **Step 5.4: Update `web-phone/main-tunnel.tsx` line 70**

```ts
// before
const DEFAULT_RELAY_URL = "https://relay.f1telemetrystationpro.org";
// after
const DEFAULT_RELAY_URL = "https://relay.f1telemetrystationpro.org";
```

- [ ] **Step 5.5: Update remaining source files (string substitution)**

For each file below, replace `f1telemetrystationpro.org` → `f1telemetrystationpro.org` and `relay.f1telemetrystationpro.org` → `relay.f1telemetrystationpro.org`:

- `web-phone/store.ts` (line 16 comment)
- `src/cli/setup-self-host.ts` (lines 25, 208 comments)
- `src/cli/pair.ts` (lines 190, 339 error messages)
- `src/cli/i18n-cli.ts` (lines 22, 59, 96 — all 3 locales)
- `src/relay-client.ts` (line 91 comment)

Spot-check command after editing:

```bash
grep -rn "f1telemetrystationpro" src/ web-phone/ tests/ worker/ 2>/dev/null
```

Expected: empty output.

- [ ] **Step 5.6: Update `worker/wrangler.toml` to drop the old route**

Change the routes block to single-host:

```toml
routes = [
  { pattern = "relay.f1telemetrystationpro.org", custom_domain = true }
]
```

- [ ] **Step 5.7: Run full test suite + typecheck**

```bash
pnpm typecheck
pnpm test
```

Expected: both PASS. The pairing test from Step 5.1 now PASSES because source code emits the new URL.

- [ ] **Step 5.8: Commit source migration**

```bash
git add tests/pairing.test.ts worker/wrangler.toml web-phone/main-tunnel.tsx web-phone/store.ts \
        src/cli/setup-wizard.ts src/cli/setup-self-host.ts src/cli/pair.ts \
        src/cli/i18n-cli.ts src/relay-client.ts
git commit -m "chore: switch hosted relay domain to relay.f1telemetrystationpro.org"
```

Commit message must NOT contain the word `f1telemetrystationpro` (gharchive will permanently retain it otherwise).

---

### Task 6: Update docs and READMEs

**Files:**
- Modify: `README.md`
- Modify: `README.zh-TW.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/deploy.md`

- [ ] **Step 6.1: Replace in `README.md`**

Locations (line numbers from grep, may drift slightly):

- Line 66: `relay.f1telemetrystationpro.org` → `relay.f1telemetrystationpro.org`
- Line 223 (example config): `wss://my-relay.<your-cf-username>.workers.dev` — leave as-is (this is a self-host example).

```bash
# After editing, verify:
grep -n "f1telemetrystationpro" README.md
```

Expected: empty.

- [ ] **Step 6.2: Replace in `README.zh-TW.md`**

Line 66, 215 (same pattern as English). Verify with grep.

- [ ] **Step 6.3: Replace in `README.zh-CN.md`**

Line 66 (same pattern). Verify with grep.

- [ ] **Step 6.4: Replace in `docs/deploy.md`**

Lines 7 and 12: `relay.f1telemetrystationpro.org` → `relay.f1telemetrystationpro.org`. Verify with grep.

- [ ] **Step 6.5: Final grep across whole tree (excluding spec/plan docs and worktree)**

```bash
grep -rn "f1telemetrystationpro" --include="*.md" --include="*.ts" --include="*.tsx" --include="*.toml" \
  --exclude-dir=node_modules --exclude-dir=.claude --exclude-dir=docs/superpowers .
```

Expected: empty. (Spec / plan docs are intentionally excluded — they will be rewritten by filter-repo in Task 11.)

- [ ] **Step 6.6: Commit**

```bash
git add README.md README.zh-TW.md README.zh-CN.md docs/deploy.md
git commit -m "docs: update README and deploy guide to relay.f1telemetrystationpro.org"
```

---

### Task 7: Clean the worktree

**Files:** branch `worktree-feat+codex-support` at `.claude/worktrees/feat+codex-support/`

- [ ] **Step 7.1: Inspect worktree state**

```bash
git worktree list
git -C .claude/worktrees/feat+codex-support log -1 --oneline
git -C .claude/worktrees/feat+codex-support status -s
```

Expected output: worktree at SHA `96851d8` on branch `worktree-feat+codex-support`, with possibly some uncommitted work.

- [ ] **Step 7.2: Decision branch — is the worktree's branch worth keeping?**

If `git log --oneline main..worktree-feat+codex-support` shows commits not yet in main → branch has unmerged work. Go to Step 7.3a.
If the branch is fully merged or contains only stale exploration → Go to Step 7.3b.

- [ ] **Step 7.3a: (Unmerged path) Replace strings on the worktree branch**

```bash
cd .claude/worktrees/feat+codex-support

# Same substitution as Tasks 5+6, scoped to this worktree:
git ls-files | grep -E '\.(ts|tsx|md|toml)$' | xargs -I {} sh -c \
  "sed -i 's/relay\.f1telemetrystationpro\.ai/relay.f1telemetrystationpro.org/g; s/cch\.f1telemetrystationpro\.ai/relay.f1telemetrystationpro.org/g; s/f1telemetrystationpro\.ai/f1telemetrystationpro.org/g; s/f1telemetrystationpro/f1telemetrystationpro/g' {}"

# Verify
grep -rn "f1telemetrystationpro" --include="*.md" --include="*.ts" --include="*.tsx" --include="*.toml" \
  --exclude-dir=node_modules .

# If empty:
git add -A
git commit -m "chore: switch hosted relay domain to relay.f1telemetrystationpro.org"
cd ../../..
```

- [ ] **Step 7.3b: (Stale path) Remove the worktree**

```bash
git worktree remove .claude/worktrees/feat+codex-support --force
git branch -D worktree-feat+codex-support
```

- [ ] **Step 7.4: Final cross-tree verification**

```bash
grep -rn "f1telemetrystationpro" --exclude-dir=node_modules --exclude-dir=.git \
  --exclude="docs/superpowers/specs/2026-05-18-migrate-hosted-relay-to-f1telemetrystationpro.md" \
  --exclude="docs/superpowers/plans/2026-05-18-migrate-hosted-relay-to-f1telemetrystationpro.md" .
```

Expected: only historical specs/plans inside `docs/superpowers/{specs,plans}/2026-05-17-*` may still hit — those will be rewritten by Task 11's filter-repo. Nothing else.

---

### Task 8: Push clean working tree to GitHub (pre-history-rewrite snapshot)

**Files:** none

- [ ] **Step 8.1: Push current main**

```bash
git push origin main
```

Expected: 3 new commits land (Task 2, Task 5, Task 6). This is the last linear push before the force-push in Task 12.

- [ ] **Step 8.2: Verify GitHub web UI shows no `f1telemetrystationpro` in latest tree**

Open `https://github.com/WarmBed/Miki-Moni` in browser. Spot-check README and `worker/wrangler.toml`. Confirm clean.

---

### Task 9: Detach old `relay.f1telemetrystationpro.org` from Worker

**Files:** none (CF dashboard action)

- [ ] **Step 9.1: Confirm wrangler.toml single-host config from Task 5.6 is deployed**

```bash
cd worker && npx wrangler deploy && cd ..
```

Expected: wrangler reports only `relay.f1telemetrystationpro.org` custom-domain binding. `relay.f1telemetrystationpro.org` should be removed from the Worker's custom-domain list.

- [ ] **Step 9.2: Verify old endpoint returns 404 / 530 / SSL hostname mismatch**

```bash
curl -sI https://relay.f1telemetrystationpro.org/v1/health
```

Expected: NOT 200. Either CF returns "no route" or the SSL cert no longer covers the hostname. This confirms detachment.

- [ ] **Step 9.3: Remove `relay.f1telemetrystationpro.org` DNS record in CF dashboard**

Manual action: CF dashboard → f1telemetrystationpro.org zone → DNS → delete the `relay` record (or set proxy to grey if it points somewhere else needed for F1TelemetryStationPro). This severs the last public link from `f1telemetrystationpro.org` to Miki-Moni.

- [ ] **Step 9.4: Final health check on new endpoint**

```bash
curl -sI https://relay.f1telemetrystationpro.org/v1/health
```

Expected: HTTP 200.

---

### Task 10: Install `git-filter-repo`

**Files:** none

- [ ] **Step 10.1: Check availability**

```bash
git filter-repo --version
```

If "git: 'filter-repo' is not a git command", install:

- [ ] **Step 10.2: Install via pip**

```bash
pip install git-filter-repo
```

Re-run `git filter-repo --version`. Expected: prints version string (e.g. `2.x`).

---

### Task 11: Rewrite git history — substitute strings in all blobs and messages

**Files:** every blob + every commit message in the repo

- [ ] **Step 11.1: Mirror-clone the repo to a working location (filter-repo safety)**

```bash
cd ..
git clone --no-local --mirror cc-hub cc-hub-rewrite.git
cd cc-hub-rewrite.git
```

- [ ] **Step 11.2: Create replacement spec file**

Create `D:\code\replace-f1telemetrystationpro.txt` (or anywhere outside the mirror) with literal content:

```
relay.f1telemetrystationpro.org==>relay.f1telemetrystationpro.org
relay.f1telemetrystationpro.org==>relay.f1telemetrystationpro.org
f1telemetrystationpro.org==>f1telemetrystationpro.org
f1telemetrystationpro==>f1telemetrystationpro
```

Order matters — longest-match-first. filter-repo applies sequentially per blob.

- [ ] **Step 11.3: Rewrite blobs**

```bash
git filter-repo --replace-text "D:/code/replace-f1telemetrystationpro.txt" --force
```

Expected: filter-repo prints object-rewrite stats; no errors. Run from inside `cc-hub-rewrite.git`.

- [ ] **Step 11.4: Rewrite the one offending commit message**

Create `D:\code\message-callback.py`:

```python
def message_callback(msg):
    return msg.replace(b'f1telemetrystationpro', b'f1telemetrystationpro')
```

Run:

```bash
git filter-repo --message-callback "$(cat /d/code/message-callback.py)" --force
```

(On Windows PowerShell use `Get-Content` equivalent; or pass `--message-callback` with a literal Python expression: `git filter-repo --message-callback 'return message.replace(b"f1telemetrystationpro", b"f1telemetrystationpro")' --force`.)

- [ ] **Step 11.5: Verify no `f1telemetrystationpro` anywhere in history**

```bash
git log --all -p | grep -c f1telemetrystationpro
git log --all --format='%s%n%b' | grep -c f1telemetrystationpro
```

Expected: both `0`.

---

### Task 12: Force-push rewritten history

**Files:** none

- [ ] **Step 12.1: Verify remote points at WarmBed/Miki-Moni**

```bash
git remote -v
```

If the mirror was cloned with `--mirror`, the remote URL should be the same as the original. If not, set it:

```bash
git remote set-url origin https://github.com/WarmBed/Miki-Moni.git
```

- [ ] **Step 12.2: Push all refs forcefully**

```bash
git push --force --all
git push --force --tags
```

Expected: GitHub accepts force-push (no protected-branch error — main is unprotected for now). All branches and tags now reference the rewritten history.

- [ ] **Step 12.3: Replace local working clone with rewritten remote**

```bash
cd /d/code/cc-hub
git fetch --all --prune
git reset --hard origin/main
git gc --prune=now --aggressive
```

- [ ] **Step 12.4: Final local verification**

```bash
git log --all -p | grep -c f1telemetrystationpro
```

Expected: `0`.

---

### Task 13: npm — unpublish all old versions

**Files:** none

- [ ] **Step 13.1: Confirm npm auth**

```bash
npm whoami
```

Expected: the publisher account. If not logged in, `npm login` first.

- [ ] **Step 13.2: Unpublish each existing version**

All 4 versions are within the 72h grace window:

```bash
npm unpublish miki-moni@0.1.0 --force
npm unpublish miki-moni@0.2.1 --force
npm unpublish miki-moni@0.2.6 --force
npm unpublish miki-moni@0.3.0 --force
```

If npm returns "you must wait 24 hours to republish this name" — that's expected for republishing the **same** version number; we'll bump version in Task 14.

- [ ] **Step 13.3: Verify removal**

```bash
curl -s https://registry.npmjs.org/miki-moni | python -c "import json,sys; d=json.load(sys.stdin); print('versions:', list(d.get('versions',{}).keys()))"
```

Expected: empty list, or 404 if the whole package is gone.

---

### Task 14: Republish clean v0.3.1

**Files:**
- Modify: `package.json` (bump version)

- [ ] **Step 14.1: Bump version in package.json**

```bash
npm version patch --no-git-tag-version
# Result: package.json version is now 0.3.1
```

- [ ] **Step 14.2: Build everything**

```bash
pnpm install
pnpm build:all
pnpm test
pnpm typecheck
```

Expected: all green.

- [ ] **Step 14.3: Dry-run pack and verify no `f1telemetrystationpro` strings in tarball**

```bash
npm pack --dry-run
npm pack
tar -tzf miki-moni-0.3.1.tgz | head -30
mkdir _tarcheck && tar -xzf miki-moni-0.3.1.tgz -C _tarcheck
grep -r "f1telemetrystationpro" _tarcheck/ ; echo "exit=$?"
rm -rf _tarcheck miki-moni-0.3.1.tgz
```

Expected: grep prints nothing, `exit=1` (no matches).

- [ ] **Step 14.4: Publish**

```bash
npm publish --access public
```

Expected: published as `miki-moni@0.3.1`.

- [ ] **Step 14.5: Commit version bump**

```bash
git add package.json pnpm-lock.yaml 2>/dev/null
git commit -m "chore(release): 0.3.1 — clean republish on relay.f1telemetrystationpro.org"
git tag v0.3.1
git push origin main --tags
```

---

### Task 15: Final cross-surface verification

**Files:** none

- [ ] **Step 15.1: GitHub repo grep**

```bash
gh api -X GET search/code -f q="f1telemetrystationpro repo:WarmBed/Miki-Moni" --jq '.total_count'
```

Expected: `0`. (May take up to 24h for GitHub search index to refresh after force-push; if non-zero, recheck tomorrow.)

- [ ] **Step 15.2: npm registry grep**

```bash
curl -s https://registry.npmjs.org/miki-moni | grep -c f1telemetrystationpro
```

Expected: `0`.

- [ ] **Step 15.3: New relay smoke test**

```bash
curl -sI https://relay.f1telemetrystationpro.org/v1/health
```

Expected: HTTP 200.

- [ ] **Step 15.4: Old relay confirmed dead**

```bash
curl -sI https://relay.f1telemetrystationpro.org/v1/health
```

Expected: NOT 200 (DNS gone or no route).

- [ ] **Step 15.5: Restore stashed pre-migration work**

```bash
git stash list
git stash pop   # if Task 1.3 stashed anything
```

- [ ] **Step 15.6: Migration complete — write summary to user**

Print to user:

```
Migration complete.
- main tree, history, npm: zero f1telemetrystationpro references
- relay.f1telemetrystationpro.org: serving traffic
- relay.f1telemetrystationpro.org: detached and DNS removed
- miki-moni@0.3.1 published, prior versions unpublished
- Residual: 1 commit-message reference in gharchive.org event log (unfixable, low-risk)
```

---

## Self-Review

**Spec coverage:**
- Goal #1 (default `wss://relay.f1telemetrystationpro.org`) → Task 5.3
- Goal #2 (no `f1telemetrystationpro` in tree or history) → Tasks 5, 6, 7, 11, 12.4
- Goal #3 (no tarball contains `f1telemetrystationpro`) → Task 14.3
- Goal #4 (old route removed) → Task 9
- Goal #5 (two-phase with checkpoint) → Phase A (1–3) + Task 4 + Phase B (5–14)
- Decision #1 (subdomain `relay.f1telemetrystationpro.org`) → Task 2.2, 5
- Decision #2 (worktree cleaned) → Task 7
- Decision #3 (unpublish all + republish) → Tasks 13, 14
- Decision #4 (historical specs/plans rewritten) → Task 11.3
- Decision #5 (skip GH Support purge) → not in plan ✓

**Placeholder scan:** No TBDs. Every step has concrete commands or code.

**Type consistency:** Variable names (`HOSTED_RELAY_URL`, `DEFAULT_RELAY_URL`) match across tasks. URL forms (`wss://` vs `https://`) preserved as in original files.

**Risk note:** Task 11.4 (`--message-callback`) syntax differs between bash and PowerShell — Step 11.4 documents both forms. If running PowerShell, prefer the inline expression form.
