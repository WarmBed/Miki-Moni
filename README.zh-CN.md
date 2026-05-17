# Miki-Moni

**[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md)**

> 巫女 (Miki the Monitor) — 看着你所有 Claude Code session，要回应的时候叫你。

把散落在各个 VSCode 窗口的 Claude Code panel 收进一张本机仪表板，手机或第二台笔电可以通过端对端加密 relay 连进来。

<p align="center">
  <img src="docs/images/dashboard-desktop.png" width="800" alt="桌面 dashboard — session 卡片含实时 transcript">
  <br />
  <em>本机 dashboard：<code>http://127.0.0.1:8765</code></em>
</p>

<table>
<tr>
<td align="center" width="33%">
  <img src="docs/images/dashboard-phone.png" width="280" alt="手机 dashboard — 同样内容、单列移动版">
  <br /><em>手机 dashboard（移动设备）</em>
</td>
<td align="center" width="33%">
  <img src="docs/images/phone-pair-screen.png" width="280" alt="手机配对画面 — 扫 QR + 16 码输入">
  <br /><em>手机配对画面 — 扫 QR 或输入 16 码</em>
</td>
<td align="center" width="33%">
  <img src="docs/images/cli-banner.png" width="280" alt="CLI banner — miki start 启动时打印 QR + URL + 16 码">
  <br /><em><code>miki start</code> 每次启动打印 QR + URL + 16 码</em>
</td>
</tr>
</table>

---

## 为什么

- 两个 VSCode 窗口开了三个 Claude Code panel，其中一个跑完了，你 20 分钟后才发现
- 离开桌前想瞥一眼"跑完没？"但不想 VPN 进来
- 同事机器有项目，你想只读看一眼

Miki-Moni 给你**一张 dashboard** 收齐所有 Claude session（跨窗口、跨项目、跨机器），任何地方都能响应。

## 安装

```bash
npm install -g miki-moni
miki start
```

或从 source 装（要贡献 / 用未 release 的改动）：

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm build:all
pnpm link --global       # 把 `miki` 加到 PATH
miki start
```

首次启动会跳设置 wizard：

1. **语言** — English / 繁體中文 / 简体中文
2. **Relay 模式** — 三选一：
   - **Hosted**（默认）— 用作者免费 `relay.f1telemetrystationpro.org`，零设置
   - **Self-host** — 自动部署 Cloudflare Worker + Pages 到你 CF 账号（需要 `wrangler`）
   - **Local-only** — 不连手机，只用本机 `127.0.0.1:8765`

然后打印永久配对 QR + 16 码：

```
📱 Phone pairing — scan QR, open URL, or type the 16-char code:

  [QR]

   URL:    https://miki-moni.pages.dev/#t=XXXX...&r=wss://...
   Code:   XXXX-XXXX-XXXX-XXXX
   Local:  http://127.0.0.1:8765
   (QR / URL / Code 永久有效 — `miki pair --rotate` 可换)
```

那个 QR 永久有效，每台要配对的设备扫一次就好。泄漏时 rotate 即可。

## 三种部署模式

|  | Hosted | Self-host | Local-only |
|---|---|---|---|
| **设置时间** | 0 秒 | 约 5 分钟 wizard | 0 秒 |
| **需要 CF 账号** | 否 | 是 | 否 |
| **手机可用** | 是 | 是 | 否 |
| **信任作者基础设施** | 是（[§ 安全](#安全)） | 否 | N/A |
| **流量限制** | 作者 CF 免费层（10 万 req/天） | 你自己 CF 免费层 | N/A |
| **随时切换** | `miki setup` | `miki setup` | `miki setup` |

## 架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│  你的电脑                                                                  │
│  ╭─────────────────────────────────────────────────────────────╮        │
│  │  miki-moni daemon (Node, 127.0.0.1:8765)                    │        │
│  │    POST /event   GET /sessions   POST /focus /send  WS /ws  │        │
│  │     ▲                       ▲                       ▲       │        │
│  │ PS hooks            浏览器 dashboard       RelayClient       │        │
│  ╰────────────────────────────────────────────┬────────────────╯        │
│                                                │ E2E 加密 envelope        │
│                                  ╭─────────────▼────────────╮            │
│                                  │ Cloudflare Worker relay  │            │
│                                  │ (零知识：只路由密文)       │             │
│                                  ╰─────────────┬────────────╯            │
│                                                ▼                         │
│                                  ╭──────────────────────────╮            │
│                                  │ 手机 / 第二台笔电 / 平板    │            │
│                                  │  · 扫 QR → 自动配对        │            │
│                                  │  · 看到一样的 dashboard    │            │
│                                  ╰──────────────────────────╯            │
└──────────────────────────────────────────────────────────────────────────┘
```

**加密**：配对时 X25519 ECDH → per-peer shared secret → 每个 envelope 用 NaCl `secretbox`。Relay 没有 key；只有 daemon 跟配对好的手机能解内容。

**认证**：每台手机握一对 Ed25519 签名 keypair（IndexedDB）。重连时签 `daemon_id || utc_minute`，relay 验签才放行。`miki pair --revoke <peer_id>` 删单个设备。

## Dashboard 功能

上方工具栏：

| | 作用 |
|---|---|
| **计数器**（`5 进行中 · 0 闲置 · 56 总览`） | 点击筛选只看那个状态，再点取消 |
| **➕ 新增 CLI** | 在指定文件夹开新 wrapped session（`miki claude --fresh`） |
| **⚙️ 设置** | 发送键（Enter vs Ctrl/⌘+Enter）、主题（亮/暗）、语言 |
| **WS 灯号** | 绿＝实时更新中 · 黄＝重连中 |

Session 卡片：

| 元素 | 作用 |
|---|---|
| **项目名 + cwd** | 卡片标题 — 点开查看完整 transcript |
| **🖥️ VSCode / 📟 CLI 切换** | 决定 *发送 / focus* 走哪边。**VSCode**：用 `vscode://anthropic.claude-code/open?session=…` 把 prompt 预填 VSCode panel。**CLI**：直接打 wrap CLI 的 WebSocket。 |
| **权限 badge**（`✏️ auto edit` / `🚀 bypass`） | 只有跑 `miki claude --permission-mode acceptEdits` / `--bypass-permissions` 的 wrap CLI session 才显示，整个 session lifetime 锁定不能改 |
| **Transcript view** | 实时渲染 Claude 对话。可开关 tool call。滚动门槛 10 / 50 / 200 / 全部。 |
| **发送输入框** | 多行 prompt。Enter 或 Ctrl/⌘+Enter 发送（按你的设置）。支持粘贴/拖图片。 |
| **开 CLI 按钮** | 开 `wt.exe`（Windows Terminal）跑 `miki claude -r <session-uuid>` 接到 wrap CLI |
| **Focus 按钮** | `POST /focus` — 把对应 VSCode 窗口（或 CLI tab）提到最前 |

## CLI 命令

| 命令 | 用途 |
|---|---|
| `miki start` | 跑 daemon + 打印配对 banner。第一次跑会跳 wizard |
| `miki setup` | 重跑 wizard（换语言、切 relay 模式等） |
| `miki pair` | 打印当前永久 QR + 已配对手机清单 |
| `miki pair --rotate` | 换新 token（旧 QR 失效；已配对手机照常工作） |
| `miki pair --list` | 列已配对手机 |
| `miki pair --revoke <peer_id>` | 删除某台手机（本机 config + relay 都清） |
| `miki pair --new` | 一次性 token（10 分钟 TTL）— 旧机制 / debug 用 |
| `miki claude [...args]` | 包一个 Claude session，daemon 没跑会自动起 |
| `miki install-hooks` | 把 Claude Code hooks 装进 `~/.claude/settings.json`，没 wrap 的 panel 也会出现在 dashboard |

启动时看详细 log：`MIKI_LOG_LEVEL=info miki start`。完整 trace 永远在 `~/.miki-moni/miki-moni.log`。

## 安全

风险按可能性排序：

| 风险 | 缓解 |
|---|---|
| 🔴 **配对 QR 泄漏**（截图、贴到聊天室、被路人拍） | 永久 QR = 任何人扫到都能 pair。把 QR 当 SSH key 看待。泄漏立刻 rotate：`miki pair --rotate` |
| 🟡 **配对手机被偷** | 手机握 Ed25519 签名 key 才能连 relay。从 daemon 删：`miki pair --revoke <peer_id>` |
| 🟢 暴力猜 token | 16 字符 Crockford base32 ≈ 80 bits entropy，宇宙热寂前猜不到 |
| 🟢 Relay 看到内容 | 零知识架构 — relay 只路由密文，不持有 shared secret |
| 🟡 信任 hosted relay 维护者 | Self-host 完全摆脱这层信任。作者看得到 metadata（peer ID、时间、大小），理论上可改 PWA bundle。源码公开，可自行 audit 或 self-host。 |
| 🟢 Hosted relay 被 DDoS | Cloudflare rate limit 限 30 req/60 秒/IP。最坏：你的当日配额烧光 |

## Self-host（手动）

`miki setup` wizard 自动做完，但要手动的话：

```bash
# 在 clone 好的 cc-hub source 树：
cd worker
wrangler login
wrangler deploy --config wrangler-selfhost.toml --name my-relay
wrangler pages project create my-phone --production-branch=main
wrangler pages deploy ../dist/web-phone --project-name my-phone --branch=main
```

然后编 `~/.miki-moni/config.json`：

```json
{
  "remote": {
    "worker_url": "wss://my-relay.<你 CF 账号>.workers.dev",
    "phone_pwa_url": "https://my-phone.pages.dev/"
  }
}
```

下次 `miki start` 就会用新 endpoints。

## 开发

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm typecheck
pnpm test         # daemon + worker tests
pnpm dev          # tsx watch src/index.ts
```

Source 结构：

| 路径 | 用途 |
|---|---|
| `src/` | Node daemon（express + ws + better-sqlite3）— hooks、配对、RelayClient |
| `web/` | 桌面 / 手机完整 dashboard（Preact + Tailwind + Vite） |
| `web-phone/` | 手机 bootstrap（QR 扫描器 + tunnel 设置）— mount web/ |
| `worker/` | Cloudflare Worker relay（DaemonRelay + PairingCoordinator DOs） |
| `extension/` | VSCode helper extension — handle `claude-vscode.send` |
| `hooks/` | Claude Code hook 脚本（PowerShell）— POST event 到 daemon |
| `bin/miki.mjs` | npm 发布的 CLI 入口 |

## 分支

- `main` — 版本化 release（当前：v0.0.0）
- `dev` — 开发中；每改动 bump `package.json` version

## 许可证

MIT — 见 [LICENSE](LICENSE)。

## Credits

用 [Anthropic Claude](https://claude.ai/code) 通过 [Claude Code](https://github.com/anthropics/claude-code) 写出来的。
