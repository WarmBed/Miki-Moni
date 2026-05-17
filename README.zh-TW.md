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

## 安裝

> ⚠️ 還沒 publish 到 npm。目前從 source 裝：

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm build:all
pnpm link --global       # 把 `miki` 加到 PATH
miki start
```

之後 publish 到 npm 後，就一行：

```bash
npm install -g miki-moni && miki start
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
| **開 CLI 按鈕** | 開 `wt.exe`（Windows Terminal）跑 `miki claude -r <session-uuid>` 接到 wrap CLI |
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

風險按可能性排序：

| 風險 | 緩解 |
|---|---|
| 🔴 **配對 QR 洩漏**（截圖、貼到聊天室、被路人拍） | 永久 QR = 任何人掃到都能 pair。把 QR 當 SSH key 看待。洩漏立刻 rotate：`miki pair --rotate` |
| 🟡 **配對手機被偷** | 手機握 Ed25519 簽章 key 才能連 relay。從 daemon 砍：`miki pair --revoke <peer_id>` |
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

## 授權

MIT — 見 [LICENSE](LICENSE)。

## Credits

用 [Anthropic Claude](https://claude.ai/code) 透過 [Claude Code](https://github.com/anthropics/claude-code) 寫出來的。
