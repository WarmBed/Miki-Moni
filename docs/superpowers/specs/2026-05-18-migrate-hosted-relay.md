# Migrate Hosted Relay: `f1telemetrystationpro.org` → `f1telemetrystationpro.org`

**Date:** 2026-05-18
**Status:** Approved (2026-05-18) — ready for writing-plans

## Background

`miki-moni` (cc-hub) currently hardcodes `relay.f1telemetrystationpro.org` / `relay.f1telemetrystationpro.org` as the default hosted relay across 11 production files, 3 READMEs, deploy docs, tests, and historical planning docs. The `f1telemetrystationpro.org` zone belongs to a separate commercial product (F1TelemetryStationPro) that is actively sold; the author wants Miki-Moni to be fully de-linked from F1TelemetryStationPro before open-source launch.

A clean domain `f1telemetrystationpro.org` already exists in the **same Cloudflare account** (`f566818c6e44ffc818fdd420d8697959`). It is parked (M1: never used for product, no live content). Reusing it as the hosted-relay zone costs $0 and 30 minutes.

The repo has:
- 0 forks, 0 stars, 0 watchers (pushed 2026-05-17)
- 4 npm versions published, all within the 72h unpublish window
- 1 commit message (`8853cf3`) referencing `relay.f1telemetrystationpro.org` — will be rewritten

## Goal

After migration:
1. Hosted relay default is `wss://relay.f1telemetrystationpro.org` (HTTPS for pairing endpoints).
2. No file in `WarmBed/Miki-Moni` (working tree or git history) contains the string `f1telemetrystationpro`.
3. No npm tarball of `miki-moni` contains `f1telemetrystationpro`.
4. Old `relay.f1telemetrystationpro.org` Worker custom-domain binding is removed.
5. Migration is **two-phase**: new relay must be verified live before any teardown / history-rewrite / unpublish.

## Non-Goals

- Not changing the phone PWA URL (`miki-moni.pages.dev` is already neutral).
- Not buying a new domain — reuse `f1telemetrystationpro.org`.
- Not moving to a new CF account — the user accepts shared-account blast radius as an acceptable risk for v1.
- Not opening a new GitHub org — repo stays at `WarmBed/Miki-Moni`.
- Not rewriting historical spec / plan files in `docs/superpowers/{specs,plans}/` — those are decision records of the time; the new spec (this file) documents the change.

## Design

### Naming

- Worker hosted-relay URL: **`relay.f1telemetrystationpro.org`** (mirrors existing `relay.f1telemetrystationpro.org` pattern; single canonical hostname — removes the current `relay.f1telemetrystationpro.org` / `relay.f1telemetrystationpro.org` split).
- Phone PWA URL: unchanged (`https://miki-moni.pages.dev/`).
- Worker `name` field in `wrangler.toml`: unchanged (`miki-relay`).

### Two-Phase Sequence

**Phase A — Stand up new relay (additive, non-breaking):**

1. Add `relay.f1telemetrystationpro.org` DNS record (proxied/orange) in CF dashboard under `f1telemetrystationpro.org` zone.
2. Add `routes` entry in `worker/wrangler.toml`: keep `relay.f1telemetrystationpro.org` binding **and** add `relay.f1telemetrystationpro.org` binding so the same Worker code serves both during transition.
3. `wrangler deploy`.
4. Verify both endpoints:
   - `curl https://relay.f1telemetrystationpro.org/v1/health` → `ok`
   - `curl https://relay.f1telemetrystationpro.org/v1/health` → `ok`
   - Manual E2E pairing test via daemon pointed at new URL.
5. **Checkpoint:** user confirms new relay works end-to-end before Phase B begins.

**Phase B — Cut over and erase:**

1. Replace all `f1telemetrystationpro.org` / `relay.f1telemetrystationpro.org` references with `relay.f1telemetrystationpro.org` in working tree (11 prod files + READMEs + deploy.md + tests).
2. Commit (`chore: switch hosted relay domain to relay.f1telemetrystationpro.org`). Do **not** mention `f1telemetrystationpro` in commit message.
3. Update `worker/wrangler.toml` to drop the old `relay.f1telemetrystationpro.org` route; `wrangler deploy` to detach.
4. In CF dashboard, remove the `relay.f1telemetrystationpro.org` DNS record (or set back to greyed/non-Worker if F1TelemetryStationPro site uses it).
5. History rewrite (after working tree is clean):
   - `git filter-repo --replace-text` to substitute `f1telemetrystationpro.org` → `f1telemetrystationpro.org` and `f1telemetrystationpro` → `f1telemetrystationpro` across all blobs in all branches.
   - `git filter-repo --message-callback` to rewrite the single offending commit message (`8853cf3`).
   - `git push --force-with-lease origin --all --tags`.
6. npm wipeout:
   - `npm unpublish miki-moni --force` (all 4 versions <72h, all eligible).
   - Wait ~24h (npm re-publish cooldown for same name+version).
   - Republish from clean tree as `0.3.1`.
7. Verify: `npm view miki-moni` shows clean tarballs; `git log --all -S f1telemetrystationpro` returns empty; GitHub search returns no hits.

### Files Touched (Phase B)

Production (from earlier grep, 11 files):
- `worker/wrangler.toml`
- `web-phone/main-tunnel.tsx`
- `web-phone/store.ts`
- `src/cli/setup-wizard.ts`
- `src/cli/setup-self-host.ts`
- `src/cli/pair.ts`
- `src/cli/i18n-cli.ts`
- `src/relay-client.ts`
- `tests/pairing.test.ts`

Docs:
- `README.md`
- `README.zh-TW.md`
- `README.zh-CN.md`
- `docs/deploy.md`

Worktree mirror `.claude/worktrees/feat+codex-support/`: **clean as well**. Plan will first run `git worktree list` to determine state:
- If the worktree is on a branch with unmerged work, perform the same `f1telemetrystationpro` → `f1telemetrystationpro` replacement on its branch and commit there.
- If it is stale / safe to discard, `git worktree remove` it.
Either way, after this migration no path under the repo (main tree or any worktree) contains `f1telemetrystationpro`.

Historical specs / plans in `docs/superpowers/specs/2026-05-17-cf-worker-implementation-design.md` and `docs/superpowers/plans/2026-05-17-cf-worker-implementation.md` are **kept as-is** (decision records). The history-rewrite step (filter-repo `--replace-text`) will incidentally rewrite their blob contents too — that is acceptable; the documents will read with `f1telemetrystationpro.org` everywhere, but the timestamp shows they predate the migration, which preserves the audit trail clearly enough.

### Tests / Verification

- `pnpm typecheck`
- `pnpm test` (including updated `tests/pairing.test.ts` fixture)
- `pnpm verify` (E2E via mock-worker — unaffected)
- Manual: `curl https://relay.f1telemetrystationpro.org/v1/health` returns `ok`
- Manual: full pairing flow daemon ↔ Worker ↔ phone PWA on new host
- After history rewrite: `git log --all -p -S f1telemetrystationpro` returns empty
- After npm wipe + republish: `npm pack miki-moni && tar -tzf miki-moni-0.3.1.tgz | xargs -I{} grep -l f1telemetrystationpro {} 2>/dev/null` returns nothing

### Acceptable Residual Exposure

- **gharchive.org** retains the public push-event log for commit `8853cf3` and others, including original commit messages. This is not removable. Risk accepted: gharchive is not Google-indexed, not browsable, accessible only via BigQuery; surface to casual discovery ≈ 0.
- **Cached third-party mirrors** (libraries.io, npms.io, sourcegraph) may continue showing `f1telemetrystationpro` strings for ~1–2 weeks until they re-crawl. Not actively addressed.

### Rollback

- Phase A is additive — if anything breaks, simply remove the new route from `wrangler.toml` and redeploy; `relay.f1telemetrystationpro.org` remains functional.
- Phase B is irreversible by design (history rewrite + npm unpublish are point-of-no-return). Therefore Phase B does not start until Phase A is fully verified and the user explicitly approves cutover.

## Decisions (resolved 2026-05-18)

1. **Subdomain:** `relay.f1telemetrystationpro.org` (default accepted).
2. **Worktree:** clean as well — see *Files Touched* above.
3. **npm:** `npm unpublish miki-moni --force` for all 4 versions (clean slate), then republish from clean tree as `0.3.1`.
4. **Historical specs / plans:** filter-repo `--replace-text` will rewrite blob contents in those files too. Accepted — the timestamps preserve audit trail, and full repo cleanliness is the priority.
5. **GitHub Support force-purge orphan blobs:** deferred. Force-push leaves orphan blobs reachable by SHA until GitHub GC (~90 days for unreferenced objects). Acceptable for this risk level; can be requested later if needed.
