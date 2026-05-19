# cc-hub / Miki-Moni — 工作守則

> 巫女 (Miki the Monitor)：把多個 VSCode Claude Code panel session 收進一張本地儀表板，並可選擇加密 relay 到手機。
> 品牌名 **Miki-Moni**（package name `miki-moni`），舊目錄 `~/.cc-hub/` 已於 2026-05-17 自動遷移到 `~/.miki-moni/`。repo 名仍叫 `cc-hub`（還沒 rename）。

## 專案定位

- **痛點驅動**：把散落 Claude session 收進一張儀表板，等回應時喊使用者；不卷功能追其他 repo（hoangsonww/simple10 等）。
- **配套**：VSCode 命令面板（Ctrl+Shift+P）走 `miki-helper` extension；不是 CLI，也不是 `/xxx` slash command。

## 子專案佈局

| 路徑 | 角色 |
|---|---|
| `src/` | Node daemon (express + ws + better-sqlite3)，listen 127.0.0.1:8765；hook handler、pairing、relay client、session store |
| `web/` | 桌面儀表板 SPA（Preact + Tailwind + Vite），build 到 `dist/web` |
| `web-phone/` | 手機 web client，build 到 `dist/web-phone` |
| `extension/` | `miki-helper` VSCode extension，WS 連回 daemon 處理 `/send`（內部 `claude-vscode.focus`） |
| `worker/` | Cloudflare Worker (relay)，protocol 見 `docs/protocols/relay-protocol.md` |
| `tools/mock-worker/` | 本地 mock relay，給 `pnpm verify` 用 |
| `hooks/miki-emit.ps1` | Claude Code hooks（SessionStart / Stop / UserPromptSubmit / PreToolUse / PostToolUse）POST 到 `/event` |
| `bin/miki.js` | `miki` CLI entry |

## 常用指令

```powershell
pnpm install
pnpm build:all        # web + web-phone
pnpm install:hooks    # merge 5 hooks 進 ~/.claude/settings.json（idempotent，會備份原檔）
pnpm start            # daemon
pnpm dev              # tsx watch
pnpm test             # vitest
pnpm typecheck
pnpm verify           # 全鏈路 E2E：daemon + mock-worker + 模擬手機
pnpm dev:all          # daemon + mock-worker + web + web-phone
pnpm pair --new --worker-url=... --token=...
```

## 開發紀律

1. **非微小改動先 writing-plans，再 TDD 實作**（auto-memory `feedback_development_workflow`）。Plans 位置 `docs/superpowers/plans/`，specs 在 `docs/superpowers/specs/`。
2. push 前跑 `pnpm test` + `pnpm typecheck`。
3. 動 hooks → 提醒使用者 `pnpm install:hooks` 重灌一次。
4. 動 protocol（`docs/protocols/*.md`）→ daemon + worker + mock-worker 三邊都要對齊。

## Phase 1 已知限制

- 跨視窗 focus 是近似的：`vscode://anthropic.claude-code/open?session=<uuid>` 只會打到目前焦點視窗（Anthropic 設計）。Phase 1.5 計畫用 Win32 `FindWindow` + `SetForegroundWindow`。
- prompt 只 pre-fill 不自動送出（Anthropic 設計）。
- 沒有 stale-session 偵測；VSCode 關掉後 dashboard 仍顯示最後狀態。
- daemon 只綁 127.0.0.1；遠端走加密 relay（Phase 2）。

## 架構速覽

```
PS hooks ──POST /event──▶  daemon (127.0.0.1:8765)  ──WS /ws──▶  web dashboard
                                │                  ──WS /ws_ext──▶ miki-helper (VSCode ext) ──/send──▶ Claude panel
                                └──加密 envelope──▶ Cloudflare Worker ──▶ 手機 web client
```

## 命名歷史

舊 `cc-hub` → 新 `Miki-Moni`（Miki + Monitor）。codebase 還沒 rename，僅 package + brand 更名。完整 mapping 見 `docs/naming.md`。
