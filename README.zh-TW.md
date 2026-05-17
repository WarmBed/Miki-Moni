# Miki-Moni

**[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md)**

> 巫女 (Miki the Monitor) — 看著你所有 Claude Code session，要回應的時候喊你。

把散落在各個 VSCode 視窗的 Claude Code panel 收進一張本機儀表板，手機或第二台筆電可以透過端對端加密 relay 連進來。

<p align="center">
  <img src="docs/images/dashboard-desktop.png" width="800" alt="桌面 dashboard — session 卡片含即時 transcript">
  <br />
  <em>本機 dashboard：<code>http://127.0.0.1:8765</code></em>
</p>

<table>
<tr>
<td align="center" width="33%">
  <img src="docs/images/dashboard-phone.png" width="280" alt="手機 dashboard — 同樣內容、單欄行動版">
  <br /><em>手機 dashboard（行動裝置）</em>
</td>
<td align="center" width="33%">
  <img src="docs/images/phone-pair-screen.png" width="280" alt="手機配對畫面 — 掃 QR + 16 碼輸入">
  <br /><em>手機配對畫面 — 掃 QR 或打 16 碼</em>
</td>
<td align="center" width="33%">
  <img src="docs/images/cli-banner.png" width="280" alt="CLI banner — miki start 啟動時印 QR + URL + 16 碼">
  <br /><em><code>miki start</code> 每次啟動印 QR + URL + 16 碼</em>
</td>
</tr>
</table>

---

## 為什麼

- 兩個 VSCode 視窗開了三個 Claude Code panel，其中一個跑完了，你 20 分鐘後才發現
- 走離桌前想瞥一眼「跑完沒？」但不想 VPN 進來
- 同事機器有專案，你想唯讀看一下

Miki-Moni 給你**一張 dashboard** 收齊所有 Claude session（跨視窗、跨專案、跨機器），任何地方都能回應。

**任何 session 都能從任何 terminal 接管繼續做。** VSCode 起的、CLI 起的都一樣，editor 崩了、視窗誤關、想換個 terminal 繼續做 — 一句 `miki claude -r <session-uuid>` 把**完整上下文**接回來。dashboard 每張 session 卡都有一鍵「Open CLI」按鈕；手機端就直接透過 relay 對同一個 session 繼續打字。再也不會「Claude 上下文掉了」 — session UUID 是耐用的把手，不是起它的那個視窗。

## 安裝

```bash
npm install -g miki-moni
miki start
```

或從 source 裝（要貢獻 / 用未 release 的改動）：

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm build:all
pnpm link --global       # 把 `miki` 加到 PATH
miki start
```

首次啟動會跳設定 wizard：

1. **語言** — English / 繁體中文 / 简体中文
2. **Relay 模式** — 三選一：
   - **Hosted**（預設）— 用作者免費 `relay.f1telemetrystationpro.org`，零設定
   - **Self-host** — 自動部署 Cloudflare Worker + Pages 到你 CF 帳號（需要 `wrangler`）
   - **Local-only** — 不配手機，只用本機 `127.0.0.1:8765`

接著印永久配對 QR + 16 碼：

```
📱 Phone pairing — scan QR, open URL, or type the 16-char code:

  [QR]

   URL:    https://miki-moni.pages.dev/#t=XXXX...&r=wss://...
   Code:   XXXX-XXXX-XXXX-XXXX
   Local:  http://127.0.0.1:8765
   (QR / URL / Code 永久有效 — `miki pair --rotate` 可換)
```

那個 QR 永久有效，每支要配對的裝置掃一次就好。洩漏時 rotate 即可。

## 三種部署模式

|  | Hosted | Self-host | Local-only |
|---|---|---|---|
| **設定時間** | 0 秒 | 約 5 分鐘 wizard | 0 秒 |
| **需要 CF 帳號** | 否 | 是 | 否 |
| **手機可用** | 是 | 是 | 否 |
| **信任作者基礎設施** | 是（[§ 資安](#資安)） | 否 | N/A |
| **流量限制** | 作者 CF 免費層（10 萬 req/天） | 你自己 CF 免費層 | N/A |
| **隨時切換** | `miki setup` | `miki setup` | `miki setup` |

## 架構

```
┌──────────────────────────────────────────────────────────────────────────┐
│  你的電腦                                                                  │
│  ╭─────────────────────────────────────────────────────────────╮        │
│  │  miki-moni daemon (Node, 127.0.0.1:8765)                    │        │
│  │    POST /event   GET /sessions   POST /focus /send  WS /ws  │        │
│  │     ▲                       ▲                       ▲       │        │
│  │ PS hooks            瀏覽器 dashboard      RelayClient        │        │
│  ╰────────────────────────────────────────────┬────────────────╯        │
│                                                │ E2E 加密 envelope        │
│                                  ╭─────────────▼────────────╮            │
│                                  │ Cloudflare Worker relay  │            │
│                                  │ (零知識：只路由密文)        │            │
│                                  ╰─────────────┬────────────╯            │
│                                                ▼                         │
│                                  ╭──────────────────────────╮            │
│                                  │ 手機 / 第二台筆電 / 平板    │           │
│                                  │  · 掃 QR → 自動配對        │           │
│                                  │  · 看到一樣的 dashboard    │            │
│                                  ╰──────────────────────────╯            │
└──────────────────────────────────────────────────────────────────────────┘
```

**加密**：配對時 X25519 ECDH → per-peer shared secret → 每個 envelope 用 NaCl `secretbox`。Relay 沒有 key；只有 daemon 跟配對好的手機能解內容。

**認證**：每支手機握一把 Ed25519 簽章 keypair（IndexedDB）。重連時簽 `daemon_id || utc_minute`，relay 驗章才放行。`miki pair --revoke <peer_id>` 砍單一裝置。

## Dashboard 功能

上方工具列：

| | 作用 |
|---|---|
| **計數器**（`5 進行中 · 0 閒置 · 56 全覽`） | 點一下篩選只看那個狀態，再點取消 |
| **➕ 新增 CLI** | 在指定資料夾開新 wrapped session（`miki claude --fresh`） |
| **⚙️ 設定** | 送出鍵（Enter vs Ctrl/⌘+Enter）、主題（淺/深）、語言 |
| **WS 燈號** | 綠＝即時更新中 · 黃＝重連中 |

Session 卡片：

| 元素 | 作用 |
|---|---|
| **專案名 + cwd** | 卡片標題 — 點開檢視完整 transcript |
| **🖥️ VSCode / 📟 CLI 切換** | 決定 *送出 / focus* 走哪邊。**VSCode**：用 `vscode://anthropic.claude-code/open?session=…` 把 prompt 預填 VSCode panel。**CLI**：直接打 wrap CLI 的 WebSocket。 |
| **權限 badge**（`✏️ auto edit` / `🚀 bypass`） | 只有跑 `miki claude --permission-mode acceptEdits` / `--bypass-permissions` 的 wrap CLI session 才會顯示，整個 session lifetime 鎖定不能改 |
| **Transcript view** | 即時渲染 Claude 對話。可開關 tool call。捲動門檻 10 / 50 / 200 / 全部。 |
| **送出輸入框** | 多行 prompt。Enter 或 Ctrl/⌘+Enter 送出（依你的設定）。支援貼/拖圖片。 |
| **開 CLI 按鈕** ⭐ | **從 CLI 接管這個 session，完整上下文都在。** 開 `wt.exe`（Windows Terminal）跑 `miki claude -r <session-uuid>` — Claude 從 VSCode panel 停的那回合接著做。原本從哪裡起的都不重要；panel 可以已關、已 crash、在另一個視窗。配上手機 dashboard，同一個 session 你在哪都能繼續打 |
| **Focus 按鈕** | `POST /focus` — 把對應 VSCode 視窗（或 CLI tab）拉到最前面 |

## CLI 指令

| 指令 | 用途 |
|---|---|
| `miki start` | 跑 daemon + 印配對 banner。第一次跑會跳 wizard |
| `miki setup` | 重跑 wizard（換語言、切 relay 模式等） |
| `miki pair` | 印當前永久 QR + 已配對手機清單 |
| `miki pair --rotate` | 換新 token（舊 QR 失效；已配對手機照常工作） |
| `miki pair --list` | 列已配對手機 |
| `miki pair --revoke <peer_id>` | 砍掉某支手機（本機 config + relay 都清） |
| `miki pair --new` | 一次性 token（10 分鐘 TTL）— 舊機制 / debug 用 |
| `miki claude [...args]` | 包一個 Claude session，daemon 沒跑會自動起 |
| `miki install-hooks` | 把 Claude Code hooks 灌進 `~/.claude/settings.json`，沒 wrap 的 panel 也會出現在 dashboard |

啟動時看詳細 log：`MIKI_LOG_LEVEL=info miki start`。完整 trace 永遠在 `~/.miki-moni/miki-moni.log`。

## 資安

### 手機能做什麼、不能做什麼

刻意把手機端能力壓到最小，威脅模型才好顧：

| 手機**可以** | 手機**不可以** |
|---|---|
| 看即時 session 狀態 + transcript | 在你電腦上跑任意 shell 指令 |
| Pre-fill prompt 進 VSCode panel（`/focus`） | 不經你 VSCode 按鍵自動送出 prompt（Anthropic 設計） |
| 對 `miki claude` 起的 session 從 wrap CLI WebSocket 推 prompt | 開新 process 或讀 session 外的檔案 |
| Focus 已存在的 panel | 繞過 Claude Code 工具權限提示（每個工具呼叫一樣會問你） |

### 信賴邊界

daemon **只綁 `127.0.0.1`** — 公網永遠戳不到。遠端走加密 relay，不走本機 HTTP port。

daemon 信任**所有跟你同帳號**的本機程序去打 `/event`、`/send`、`/focus`、`/ws_ext`。這是故意的（Claude Code hooks 跟 VSCode helper extension 才不用帶 token），但代價是：**任何以你身分跑的程序都能跟 daemon 講話**。完整本機信賴分析跟硬化選項見 [`docs/security/hooks-trust-model.md`](docs/security/hooks-trust-model.md) 跟 [`docs/security/extension-ws-trust-model.md`](docs/security/extension-ws-trust-model.md)。

### 風險表

按可能性排序：

| 風險 | 緩解 |
|---|---|
| 🔴 **配對 QR 洩漏**（截圖、貼到聊天室、被路人拍） | 永久 QR = 任何人掃到都能 pair。把 QR 當 SSH key 看待。洩漏立刻 rotate：`miki pair --rotate` |
| 🟡 **配對手機被偷** | 手機握 Ed25519 簽章 key 才能連 relay。從 daemon 砍：`miki pair --revoke <peer_id>` |
| 🟡 **本機被入侵** | daemon 信任 loopback。任何以你身分跑的惡意程序可讀 session、可從 `/ws_ext` 攔 prompt。`~/.miki-moni/`（私鑰、配對紀錄）請當 `~/.ssh/` 那樣保護 |
| 🟢 暴力猜 token | 16 字元 Crockford base32 ≈ 80 bits entropy，宇宙熱寂前猜不到 |
| 🟢 Relay 看到內容 | 零知識架構 — relay 只路由密文，不持有 shared secret |
| 🟡 信任 hosted relay 維運者 | Self-host 完全擺脫這層信任。作者看得到 metadata（peer ID、時間、大小），理論上可改 PWA bundle。原始碼公開，可自行 audit 或 self-host。 |
| 🟢 Hosted relay 被 DDoS | Cloudflare rate limit 限 30 req/60 秒/IP。最壞：你的當日額度燒光 |

## Self-host（手動）

`miki setup` wizard 自動做完，但要手動的話：

```bash
# 在 clone 好的 cc-hub source 樹：
cd worker
wrangler login
wrangler deploy --config wrangler-selfhost.toml --name my-relay
wrangler pages project create my-phone --production-branch=main
wrangler pages deploy ../dist/web-phone --project-name my-phone --branch=main
```

接著編 `~/.miki-moni/config.json`：

```json
{
  "remote": {
    "worker_url": "wss://my-relay.<你 CF 帳號>.workers.dev",
    "phone_pwa_url": "https://my-phone.pages.dev/"
  }
}
```

下次 `miki start` 就會用新 endpoints。

## 開發

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm typecheck
pnpm test         # daemon + worker tests
pnpm dev          # tsx watch src/index.ts
```

Source 結構：

| 路徑 | 用途 |
|---|---|
| `src/` | Node daemon（express + ws + better-sqlite3）— hooks、配對、RelayClient |
| `web/` | 桌面 / 手機完整 dashboard（Preact + Tailwind + Vite） |
| `web-phone/` | 手機 bootstrap（QR 掃描器 + tunnel 設定）— mount web/ |
| `worker/` | Cloudflare Worker relay（DaemonRelay + PairingCoordinator DOs） |
| `extension/` | VSCode helper extension — handle `claude-vscode.send` |
| `hooks/` | Claude Code hook 腳本（PowerShell）— POST event 到 daemon |
| `bin/miki.mjs` | npm 發佈的 CLI 入口 |

## Branch

- `main` — 版本化 release（目前：v0.0.0）
- `dev` — 開發中；每改動 bump `package.json` version

## 相關專案

**[Happy](https://happy.engineering)**（`slopus/happy-cli`, MIT）切的痛點有重疊 — 從手機操控 Claude Code — 但角度不同。兩者可以同一台機器並存。

|  | Miki-Moni | Happy |
|---|---|---|
| 主入口 | VSCode panel — hooks 把每個 panel 拉進 dashboard | 取代 `claude` 的 terminal wrapper |
| Relay | Cloudflare Worker；可以 5 分鐘 self-host 到自己 CF 帳號 | 作者自架 socket.io server（`api.cluster-fluster.com`） |
| 手機端 | Web PWA — 掃 QR 就能用，免裝 app | 原生 iOS / Android app |
| 支援 agent | Claude Code | Claude Code、Codex、Gemini、通用 ACP |
| 語音輸入 | — | 有 |
| 多 session 視覺化 dashboard | 有 — 跨視窗聚合 | 各 session 獨立管 |
| 取代 `claude` 嗎 | 不取代 — hooks 並存 | 取代，自己 spawn `claude` |
| 遠端 spawn（人不在桌前也能起新 session） | — | 有（`happy daemon`） |
| 加密 relay | 有（X25519 + NaCl secretbox） | 有（X25519 + NaCl secretbox + AES-GCM） |

想要打磨好的手機原生體驗、跨多個 AI agent、不介意 SaaS relay → 用 Happy。住在 VSCode 裡、想要一張 dashboard 收齊多個並行 panel、想 self-host 到自己 CF → 用 Miki-Moni。

## 授權

MIT — 見 [LICENSE](LICENSE)。

## Credits

用 [Anthropic Claude](https://claude.ai/code) 透過 [Claude Code](https://github.com/anthropics/claude-code) 寫出來的。
