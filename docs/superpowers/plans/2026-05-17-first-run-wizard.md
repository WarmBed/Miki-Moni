# First-Run Setup Wizard (L2) — Implementation Plan

**Goal:** `miki start` on a fresh install prompts user once: use hosted relay (default) / self-host (auto wrangler deploy) / local-only. Choice saved to `~/.miki-moni/config.json`; subsequent runs skip the wizard.

**Architecture:** New module `src/cli/setup-wizard.ts` invoked from `miki.ts` when `config.remote` is missing AND TTY is interactive. Hosted path = write defaults. Self-host path = spawn `wrangler login` + `wrangler deploy` + capture URLs. Local-only path = explicitly mark `remote: null`.

**Tech Stack:** `@inquirer/prompts` (~50KB, well-maintained), spawned `wrangler` (already worker/ dep).

---

### Task 1: Add `@inquirer/prompts` dep + thin wrapper

**Files:**
- Modify: `package.json` (add dep)
- Create: `src/cli/prompt.ts` (re-export `select`, `input`, `confirm` — single import surface, easier to swap library later)

### Task 2: Wizard module — hosted / self-host / local-only branching

**Files:**
- Create: `src/cli/setup-wizard.ts`
- Create: `tests/setup-wizard.test.ts`

- Exposes `runSetupWizard(cfg, configPath): Promise<Config>` — returns updated config; caller saves.
- Hosted path: writes `remote.worker_url = "wss://relay.f1telemetrystationpro.org"`, `remote.phone_pwa_url = "https://miki-moni.pages.dev/"`. Done in 100ms.
- Local-only path: writes `remote = undefined`. Done.
- Self-host path: delegate to `runSelfHostWizard()` (Task 3).
- Test: each branch returns the right shape; non-TTY (CI) skips and returns hosted defaults.

### Task 3: Self-host sub-wizard — spawn wrangler

**Files:**
- Create: `src/cli/setup-self-host.ts`
- Create: `tests/setup-self-host.test.ts`

Steps:
1. Check `npx wrangler --version` works (otherwise tell user `npm install -g wrangler` and bail).
2. Generate suggested name `miki-relay-${4-char-random}` (avoids hard collisions on user's CF account).
3. Prompt: edit worker name / pages name / keep defaults.
4. Spawn `wrangler login` (inherits stdio so user sees OAuth flow).
5. Spawn `wrangler deploy` in `<package-root>/worker/` with `--name <chosen>`. Parse stdout for the deployed URL.
6. Spawn `wrangler pages deploy <package-root>/dist/web-phone --project-name <chosen>`. Parse URL.
7. Write both URLs to config.
8. Print "now restart: `miki start`" — wizard exits, user re-runs.

Tests: mock spawn, verify URL parse logic on canned wrangler output.

### Task 4: Bundle worker/ + dist/web-phone into npm package

**Files:**
- Modify: `package.json` `files` array — add `worker/src/**/*.ts`, `worker/wrangler.toml`, `worker/package.json`, `dist/web-phone/**/*`

After publish: `npm install -g miki-moni` ships the worker source so wrangler deploy works without git clone.

### Task 5: Wire wizard into `miki start`

**Files:**
- Modify: `src/cli/miki.ts`

Before `printPairBanner()` in `start`/`daemon` branch:
1. Load config.
2. If `!cfg.remote` AND `process.stdin.isTTY`: run wizard → save config.
3. Continue with existing banner + delegate to index.ts.

### Task 6: Deploy + verify

- `npm pack` locally → install in fresh tmp dir → `miki start` → walk through wizard → verify config written, banner shows correct URL.

---

## Scope cuts (NOT in v1)

- Auto-create CF custom domain for self-host (manual `f1telemetrystationpro.org`-style setup; user does it after)
- DNS verification
- Rollback on partial deploy failure (user can re-run wizard)
- Migration tool for existing users (they already have config; wizard skips them)

## Commits

One per task. Conv-commit format.
