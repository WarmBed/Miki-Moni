---
name: miki-moni-dev-release-flow
description: Use when shipping a new version of miki-moni (a.k.a. cc-hub). Triggers on "release miki-moni", "publish 0.x.y", "push to main and update npm", "deploy worker + pages", "ship the fix". Covers the full bump → test → push → worker deploy → Pages deploy → npm publish sequence with all the gotchas learned from 0.3.x releases.
---

# Miki-Moni Release Flow

End-to-end procedure for cutting a new version. Skipping any step has bitten us before — DNS-rebind guard, daemon-pubkey-in-QR, paired_peers prune — every release touches multiple deployment targets that don't auto-sync.

## Three deployment targets, three different commands

| Target | Command | Affects |
|---|---|---|
| **GitHub** | `git push origin main` | source code visible publicly |
| **npm registry** | `npm publish --access public` | `npm i -g miki-moni` upgrade |
| **Cloudflare Worker** (`relay.f1telemetrystationpro.org`) | `cd worker && npx wrangler deploy` | relay routing logic for ALL connected users |
| **Cloudflare Pages** (`miki-moni.pages.dev`) | `npx wrangler pages deploy dist/web-phone --project-name miki-moni --branch main` | the PWA users open on their phone |

**Forget any one and you ship a broken upgrade.** Specifically:
- Skip worker deploy → new client code talks to old worker, protocol drift
- Skip Pages deploy → users on the PWA keep running old JS that doesn't match new daemon
- Skip npm publish → `npm i -g` users stay on old daemon

## Standard release sequence

```
1. Decide version bump          (patch / minor / major)
2. Edit package.json version
3. pnpm typecheck               (must pass)
4. pnpm vitest run              (must pass — flaky wrap-process test on Windows is known, retry once)
5. pnpm build:web               (PowerShell 5.1: no && chaining — run separately)
6. pnpm build:phone
7. Stage ONLY intended files    (git add <files>, NOT git add -A)
8. git commit with chore(release): X.Y.Z — <summary>
9. git push origin main
10. If worker code changed:     cd worker && npx wrangler deploy
11. If web-phone bundle changed: npx wrangler pages deploy dist/web-phone --project-name miki-moni --branch main --commit-dirty=true
12. npm publish --access public
13. Verify: npm view miki-moni version
14. (optional) Tell user how to upgrade: npm i -g miki-moni@latest
```

## What touches what

| Files changed | Worker deploy? | Pages deploy? | npm? |
|---|---|---|---|
| `src/**` (daemon) | no | no | YES |
| `bin/`, `tools/`, `hooks/` | no | no | YES |
| `web/app.tsx` (dashboard) | no | YES (phone embeds web/app.tsx via main-tunnel) | YES |
| `web-phone/**` | no | YES | YES |
| `worker/src/**` | **YES** | no | no (worker isn't shipped via npm) |
| `shared/i18n.ts` | no | YES | YES |
| `package.json` version | no | YES (Pages bundles it) | YES |

When in doubt: ship to all three. Worker + Pages are idempotent.

## Commit message convention

Follow existing pattern (see `git log --grep=release`):

```
chore(release): X.Y.Z — <one-line summary in user-visible terms>

<paragraphs explaining what changed and why>

<bullet list of notable items>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Known traps

| Trap | What happens | Avoid |
|---|---|---|
| `cd worker && wrangler deploy` then forgetting `cd ..` | next `npm publish` runs in `worker/` which is marked `private` → "marked as private" error | always `pwd` after `cd` or use `cd /d/code/cc-hub` to reset |
| `git add -A` while there's untracked stuff from parallel sessions | accidentally commits `.claude/worktrees/feat+codex-support`, smoke-test scripts, debug PNGs | always `git add <specific files>` |
| `npm i -g miki-moni@latest` while `miki claude` panel still open | EBUSY locking `claude.exe` (Anthropic SDK binary) | ask user to Ctrl+C every wrap process first |
| Forgetting to bump version | `npm publish` says "you cannot publish over the previously published versions" | check `package.json` before commit |
| `pnpm build:all` on Windows 5.1 PowerShell | parser error on `&&` | run `build:web` then `build:phone` separately |
| Wrap-process test flaky (kills live tree) | exit 1 on a normally-passing run | rerun once: `pnpm vitest run tests/wrap-process.test.ts` — confirmed flaky in Windows process tree timing |
| Cherry-pick to main from wrong branch (e.g. `feat/codex-merge`) | release commit lands on wrong branch, main stays behind | `git branch` before commit; if needed `git checkout main && git cherry-pick <sha>` |

## Verification after release

```powershell
npm view miki-moni version                          # should match new version
curl -s https://miki-moni.pages.dev/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'  # new bundle hash
curl -s https://relay.f1telemetrystationpro.org/v1/health    # "ok"
```

For user-facing testing:
1. Hard reload phone PWA tab (Ctrl+Shift+R or "Empty Cache and Hard Reload")
2. Check F12 Network for new bundle hash
3. Pair / send / etc. as smoke test

## Hotfix flow (a.k.a. patch release)

Same sequence but skip steps that didn't change. A single-file hotfix is still safest to deploy to all three targets — the Pages + npm builds are cheap, and skipping worker is fine if `worker/src/**` is untouched.

If you literally only changed a comment / README:
```
1-4. unchanged
5-6. skip if no web changes
9.   push
12.  skip npm if package.json version bumped only for docs
```

## Related skills

- `miki-moni-dev:locate-code` — find files affected before deciding which targets to deploy
- `miki-moni-dev:change-pair-flow` — pair/relay code has extra deploy considerations (both worker + client must move together)
