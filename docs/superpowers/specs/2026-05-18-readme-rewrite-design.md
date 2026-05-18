# README rewrite — design spec

**Date:** 2026-05-18
**Scope:** Rewrite `README.md`, `README.zh-TW.md`, `README.zh-CN.md` from scratch based on current architecture (v0.3.3 + post-0.3.0 surface).

## Motivation

The current README has accumulated five concrete problems (user-confirmed):

1. **Architecture diagram doesn't match reality** — ASCII art shows only daemon + worker + phone. Missing: PS hooks, VSCode helper extension, wrap CLI, model-switching control plane, IndexedDB-held phone keys.
2. **Fat tables** — "Dashboard features" table mixes top bar / session card / mobile gestures into one block; cells are 2-3 sentence paragraphs.
3. **Long, walled-of-text bullets** — Risk table, CLI reference, Happy comparison are exhaustive rather than skim-friendly.
4. **Security / deployment modes tangled** — three modes table + trust-boundaries prose + risk table all stack vertically; reader can't tell what the takeaway is.
5. **Repeated narration** — "Open CLI takeover" appears in `Why`, in `Dashboard features`, and in a standalone paragraph. Dynamic model switching is in `What's new` and `Dashboard features`. Mobile UX similar.

## Audience

A developer at the same level as the project author. Uses Claude Code, knows VSCode, doesn't need "what is a session" explained. Optimize for **skimming + grepping**, not for onboarding from zero.

## Target structure

11 sections, ordered to let a reader bail out at any point:

```
1. Hero
   - Title + one-line position
   - Big desktop dashboard screenshot
   - Three quick-link pills: Install / Architecture / Self-host

2. What it is  (~80 words)
   - The problem in one paragraph
   - Three bullets: aggregates / encrypted relay / hooks alongside (not a wrapper)

3. Quick start  (~60 words + code block)
   - `npm install -g miki-moni && miki start`
   - One screenshot/text-block of the wizard output
   - One sentence: "that's it; QR is permanent"

4. Architecture  (the centerpiece; rewritten)
   - Single ASCII diagram showing:
     · PS hooks → POST /event
     · wrap CLI ↔ WS /ws_ext
     · VSCode helper extension ↔ WS /ws_ext
     · daemon (127.0.0.1:8765) holding session store + RelayClient
     · web dashboard ↔ WS /ws
     · RelayClient ↔ Cloudflare Worker (E2E encrypted)
     · Worker ↔ phone PWA
   - Five labeled message paths (event-in, dashboard-out, send-out, focus-out, relay)
   - One-line description per component (≤8 components, ≤8 lines)

5. Features  (consolidated; replaces What's new + Dashboard features)
   Three sub-headings, 3-5 bullets each, with screenshots inline:
   - **Dashboard** — multi-session grid, status counters, transcript view
   - **Session control** — model chip, mode chip with color, Open-CLI takeover, send composer with images
   - **Mobile** — chat bubbles, swipe-to-close, image upload, iOS fixes, collapsed transcript controls

6. Deployment modes  (3-mode comparison table only — 1 table, no surrounding prose)

7. Security  (compressed; ~150 words)
   - One paragraph: trust model in plain words
   - One small "phone can / can't" table (4 rows max)
   - One sentence: "Risks + hardening details in docs/security/"

8. CLI reference  (top 6 commands only)
   - start / setup / pair / pair --rotate / claude / install-hooks
   - One line each
   - Note: `miki --help` for the full list

9. Development  (~50 words + code block)
   - Clone / pnpm install / pnpm dev / pnpm test
   - One-line pointer to source tree (link, not table)

10. Related projects  (Happy comparison, ~80 words)
    - 4-row table (entry point / relay / phone client / supported agents)
    - Two sentences on when to pick which

11. License + Credits
```

## Content rules

- **One feature, one mention** — Open-CLI takeover lives in Features § Session control only. Not in What-it-is, not in Quick start.
- **Tables for comparison, not for description** — feature descriptions become bullets with a leading bold label. Tables only when there are 2+ columns of values to compare.
- **No "What's new" section** — version highlights belong in CHANGELOG; README documents the current product.
- **Cap each section** — if a section needs >250 words, split or link to `docs/`.
- **Screenshots are inline figures, not section heroes** — embed at relevant feature bullets, not as a top-of-section gallery.

## Screenshot plan

Inline placements:

| Where | Screenshot | File |
|---|---|---|
| Hero | desktop dashboard | `dashboard-desktop.png` (existing) |
| § Features / Dashboard | desktop dashboard close-up of session card | TODO — placeholder |
| § Features / Session control / Model chip | model picker popover | `model-picker.png` |
| § Features / Session control / Mode chip | mode picker popover | `mode-picker.jpg` |
| § Features / Mobile | phone dashboard grid | `dashboard-phone.png` |
| § Features / Mobile | phone session modal | `phone-session-modal.png` |
| § Features / Mobile | composer bar | `composer-bar.jpg` |
| § Quick start | wizard CLI output | `cli-banner.png` (existing) |
| § Quick start | phone pair screen | `phone-pair-screen.png` (existing) |

Items the user said they'd supply later: a fresh desktop-dashboard screenshot. Placeholder format in the README will be:

```html
<!-- TODO(screenshot): desktop dashboard, post-0.3.0 chat-bubble layout -->
<img src="docs/images/dashboard-desktop.png" width="800" alt="..." />
```

## Localization

Three READMEs, content parity. Workflow:

1. Write English first, get user approval on the structure + prose.
2. Translate to zh-TW (Taiwan idioms — same register as current zh-TW).
3. Translate to zh-CN from zh-TW with mainland word swaps (项目/檔案/伺服器 etc.).

## Out of scope

- Not rewriting `docs/security/*.md`, `docs/protocols/*.md`, or `docs/architecture.md` — only the README.
- Not changing the npm package description, repo description, or GitHub topics.
- Not regenerating ASCII diagrams in other docs — only the one in README.
- Not capturing new screenshots in this work — user supplies a fresh desktop dashboard shot when ready.

## Success criteria

- A reader who has never seen Miki-Moni can answer "what does it do, how do I run it, what does it cost me in trust" in under 90 seconds of reading.
- A returning reader can find a feature by name with one Ctrl-F.
- No fact appears in two sections.
- All three language versions have identical structure and section ordering.
