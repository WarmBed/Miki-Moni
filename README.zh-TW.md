# Miki-Moni

**[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md)**

> 巫女 (Miki the Monitor) — 一張 dashboard 收齊你所有 Claude Code session，可端對端加密從手機遙控。

<p align="center">
  <img src="docs/images/dashboard-desktop.png" width="820" alt="桌面 dashboard — session 卡片 + 即時 transcript">
</p>

<p align="center">
  <a href="#快速開始">安裝</a> ·
  <a href="#架構">架構</a> ·
  <a href="#self-host">Self-host</a> ·
  <a href="#資安">資安</a>
</p>

---

## 這是什麼

你同時開了好幾個 Claude Code panel。其中一個跑完了，你 20 分鐘後才發現。你離開桌前想瞄一眼「跑完沒？」，但不想 VPN 進來。同事機器上有 context，你想唯讀看一下。

Miki-Moni 用 hooks 串接每一個 Claude Code panel，把它們聚合到本機 `http://127.0.0.1:8765` 一張 dashboard 上。要的話，加密 relay 讓手機或第二台電腦看到同一個畫面，並能推 prompt 回來。

- **聚合，不是取代。** Hooks 跟 `claude` 並存 — 你照原本方式起 session
- **同一個對話，跨任何裝置。** 在電腦 A 起的話，搭車路上用手機繼續打，回家再用電腦 B 接著做 — 同一個 session UUID、同一份 transcript、同一份 context。不用把進度貼到新 prompt 裡
- **Session 撐得比視窗久。** 任何 session 都能用 UUID 從任何 terminal 接回完整 context：`miki claude -r <uuid>`，原本的 panel 已關 / crash 都不影響
- **預設純本機，自己選才走遠端。** Daemon 只綁 `127.0.0.1`。手機端走端對端加密 envelope，relay 不持有任何 key

## 快速開始

```bash
npm install -g miki-moni
miki start
```

首次啟動跑 wizard：選語言、選 relay 模式（hosted / self-host / local-only）、印永久配對 QR：

<p align="center">
  <img src="docs/images/cli-banner.png" width="520" alt="miki start 印 QR + URL + 16 碼">
</p>

每支要配對的裝置掃一次 QR 就好。Token 永久有效，除非你 `miki pair --rotate`。Dashboard 在 [http://127.0.0.1:8765](http://127.0.0.1:8765)。

## 架構

```
┌─ 你的電腦 ─────────────────────────────────────────────────────────────┐
│                                                                        │
│  Claude Code（任何 panel）                                             │
│   │                                                                    │
│   │ PS hooks（SessionStart / Stop / UserPromptSubmit / PreToolUse /    │
│   │            PostToolUse）                                           │
│   │  ── POST /event ──▶                                                │
│   │                                                                    │
│   │   ┌──────────────────────────────────────────────────────────┐    │
│   │   │  miki-moni daemon（Node, 127.0.0.1:8765）                │    │
│   │   │  ─ session 儲存（better-sqlite3）                         │    │
│   │   │  ─ HTTP：/event /sessions /focus /send /wrap/*           │    │
│   │   │  ─ WS：  /ws（dashboard） /wrap（CLI） /ws_ext（ext）    │    │
│   │   │  ─ RelayClient（X25519 + NaCl secretbox）                │    │
│   │   └─────┬──────────────┬────────────────┬───────────┬───────┘    │
│   │         │ WS /ws       │ WS /ws_ext     │ WS /wrap  │ relay      │
│   ▼         ▼              ▼                ▼           │ envelope   │
│  hooks    瀏覽器 dashboard  VSCode helper   miki claude │            │
│           （Preact SPA）   extension       （wrap CLI）  │            │
│                                                          │            │
└──────────────────────────────────────────────────────────┼────────────┘
                                                           │
                                       ╭───────────────────▼──────────╮
                                       │ Cloudflare Worker relay      │
                                       │ （零知識：只路由不透明 blob，│
                                       │   不持有任何 key）            │
                                       ╰───────────────────┬──────────╯
                                                           │ E2E 加密
                                                           ▼
                                       ╭──────────────────────────────╮
                                       │ 手機 PWA / 第二台電腦         │
                                       │ Ed25519 keypair 存 IndexedDB │
                                       ╰──────────────────────────────╯
```

| 元件 | 角色 |
|---|---|
| **PS hooks** | Claude Code 在 session / tool 邊界 POST 到 `/event`，沒 wrap 的 panel 也會被 dashboard 看到 |
| **daemon** | Node + express + ws + better-sqlite3。持有 session 狀態，路由四個 WS 平面 |
| **瀏覽器 dashboard** | Preact + Tailwind SPA 掛在 `/`。讀 `/ws`，POST `/send` 跟 `/focus` |
| **wrap CLI**（`miki claude`） | 包一個 Claude Code session，讓 daemon 能推 prompt（`/send`）、切模型（`/wrap/model`）、用 UUID resume |
| **VSCode helper extension** | 連 `/ws_ext`；接收 `claude-vscode.focus` 把 prompt 預填進當前 panel |
| **RelayClient** | E2E 加密 envelope（每個 peer 一把 X25519 ECDH → NaCl secretbox），打到 Worker |
| **Cloudflare Worker** | Stateless relay。在 daemon 跟配對 peer 之間路由密文。驗 `daemon_id ‖ utc_minute` 的 Ed25519 簽章 |
| **手機 PWA** | Web client 從 Pages 出。掃 QR，IndexedDB 存 Ed25519 簽章 key，跟 relay 溝通 |

完整協定見 [`docs/protocols/relay-protocol.md`](docs/protocols/relay-protocol.md)。

## 功能

### Dashboard

- **多 session 網格** — 本機上每一個 Claude Code panel，不管哪個 VSCode 視窗或 terminal 起的都收進來
- **狀態計數器可篩選** — 點 `5 進行中` 把網格收斂到那個狀態，再點取消
- **New CLI popover** — 在任意資料夾起一個全新的 `miki claude --fresh`；最近用過的 cwd 用原生下拉選單記著，跳新專案一鍵搞定
- **即時 transcript** 用聊天泡泡版面（user 右、assistant/system/tool 左）。可切 tool call 顯示，捲動門檻 10 / 50 / 200 / 全部
- **WS 燈號** — 綠 = 即時接收中，黃 = 重連中

<p align="center">
  <img src="docs/images/new-cli-popover.png" width="320" alt="New CLI popover — 資料夾路徑 + 最近 cwd 下拉">
</p>

### Session 控制

- **Model chip** — 點開即時切模型：default / Sonnet / Opus / Haiku / 自訂 id。透過 `POST /wrap/model` 廣播到每張 dashboard
- **Mode chip 帶顏色** — `acceptEdits` 藍、`bypass` 紅、ask 灰。整個 session lifetime 鎖定
- **Open CLI** — 開 `wt.exe` 跑 `miki claude -r <session-uuid>`，從 terminal 接管 session 帶完整 context。原本的 panel 已關或 crash 都不影響
- **送出輸入框** — 多行輸入自動長高。Enter 或 Ctrl/⌘+Enter 送出（依你的設定）。支援貼上、拖曳、按鈕選圖片附件

<p align="center">
  <img src="docs/images/model-picker.png" width="240" alt="Model 切換 popover">
  <img src="docs/images/mode-picker.jpg" width="240" alt="Mode 切換 popover">
</p>

### 手機

- **手機 dashboard** — 一樣的網格，單欄、行動裝置友善的點擊區
- **聊天泡泡 transcript** 跟桌面同步，適配手機 viewport
- **右滑關閉** session modal — document 層級手勢 + translateX 預覽
- **Composer** 帶圖片上傳鈕（手機 file picker）、textarea 自動長高、修好 iOS focus-zoom 跟鍵盤縮放
- **Transcript 控制可折疊**（show-tool / limit / load-all / reload）藏在一個 sliders popover 裡

<p align="center">
  <img src="docs/images/dashboard-phone.png" width="240" alt="手機 dashboard">
  <img src="docs/images/phone-session-modal.png" width="240" alt="手機 session modal">
</p>

## 部署模式

|  | Hosted | Self-host | Local-only |
|---|---|---|---|
| 設定時間 | 0 秒 | 約 5 分鐘 wizard | 0 秒 |
| 需要 CF 帳號 | 否 | 是 | 否 |
| 手機可連 | 是 | 是 | 否 |
| 信任作者基礎設施 | 是 | 否 | N/A |
| 流量上限 | 作者 CF 免費層（約 10 萬 req/天） | 你自己 CF 免費層 | N/A |
| 之後可切換 | `miki setup` | `miki setup` | `miki setup` |

預設是 **Hosted**，指向 `relay.f1telemetrystationpro.org`。選 Self-host 時 wizard 會把 Worker + Pages 部署到你的 CF 帳號。

## 資安

Daemon **只綁 `127.0.0.1`** — 公網永遠戳不到。手機端走端對端加密（配對時 X25519 ECDH → 每個 envelope NaCl `secretbox`）。Relay 只路由密文，不持有任何共享金鑰。

Daemon 信任**所有以你身分跑的程序**去呼叫 `/event`、`/send`、`/focus`、`/ws_ext`。這讓 hooks 跟 helper extension 不用帶 token，但代價是：任何以你身分跑的程序都能跟 daemon 講話。`~/.miki-moni/` 請當 `~/.ssh/` 那樣保護。

| 手機**可以** | 手機**不可以** |
|---|---|
| 看即時 session 狀態 + transcript | 在你電腦上跑任意 shell 指令 |
| 推 prompt（pre-fill 進 VSCode、直送 wrap CLI） | 不經你 VSCode 按鍵就自動送出 prompt |
| Focus 已存在的 panel | 繞過 Claude Code 每個工具的權限提示 |

風險表、硬化選項、完整 hooks / extension 信賴分析見 [`docs/security/`](docs/security/)。

## CLI 指令

| 指令 | 用途 |
|---|---|
| `miki start` | 跑 daemon；首次啟動會跳 wizard |
| `miki setup` | 重跑 wizard（換語言、切 relay 模式） |
| `miki pair` | 印永久 QR + 已配對手機清單 |
| `miki pair --rotate` | 換新 token（舊 QR 失效；已配對手機照常工作） |
| `miki claude [...args]` | 包一個 Claude Code session，daemon 沒跑會自動起 |
| `miki install-hooks` | 把 Claude Code hooks merge 進 `~/.claude/settings.json` |

完整清單見 `miki --help`。詳細 log：`MIKI_LOG_LEVEL=info miki start`，完整 trace 永遠在 `~/.miki-moni/miki-moni.log`。

## Self-host

Wizard 會做完全程；要手動部署：

```bash
cd worker
wrangler login
wrangler deploy --config wrangler-selfhost.toml --name my-relay
wrangler pages project create my-phone --production-branch=main
wrangler pages deploy ../dist/web-phone --project-name my-phone --branch=main
```

然後把 `~/.miki-moni/config.json` 指到你的 endpoint：

```json
{
  "remote": {
    "worker_url": "wss://my-relay.<你的 cf 帳號>.workers.dev",
    "phone_pwa_url": "https://my-phone.pages.dev/"
  }
}
```

## 開發

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm dev          # tsx watch src/index.ts
pnpm test         # daemon + worker tests
pnpm typecheck
```

Source tree：`src/` daemon · `web/` dashboard SPA · `web-phone/` 手機 bootstrap · `worker/` Cloudflare Worker · `extension/` VSCode helper · `hooks/` PS hook scripts · `bin/miki.mjs` CLI 入口。

Branch：`main` 出 release（目前 **v0.3.3**），`dev` 跑開發、每個改動 bump `package.json`。

## 相關專案

**[Happy](https://happy.engineering)**（`slopus/happy-cli`）切的痛點有重疊但角度不同，兩者可同機並存。

| | Miki-Moni | Happy |
|---|---|---|
| 入口 | hooks 進現有 panel | 取代 `claude` |
| 手機端 | Web PWA（免裝） | 原生 iOS / Android |
| 多 session dashboard | 有 — 聚合網格 | 各 session 獨立 |
| 支援 agent | Claude Code | Claude Code、Codex、Gemini、ACP |

想要打磨好的手機原生體驗、跨多個 AI agent → 用 Happy。住在 VSCode 裡、想要一張 dashboard 收齊每個 panel、想幾分鐘 self-host → 用 Miki-Moni。

## License

MIT — 見 [LICENSE](LICENSE)。

## Credits

用 [Anthropic Claude](https://claude.ai/code) 透過 [Claude Code](https://github.com/anthropics/claude-code) 寫出來的。
