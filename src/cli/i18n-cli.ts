// Tiny i18n module for CLI / setup wizard strings.
//
// Kept separate from web/i18n.ts (which serves the dashboard); CLI strings
// rarely change and don't need a full framework. Add new keys at the bottom
// of LOCALES and call `t(key)` from CLI code.
//
// Locale resolution order:
//   1. explicit setLocale() call (used after wizard picks one)
//   2. config.locale loaded from ~/.miki-moni/config.json
//   3. process.env.MIKI_LOCALE (override for one-off CLI runs)
//   4. "en" default

import type { Locale } from "../config.js";

type Bundle = Record<string, string>;

const LOCALES: Record<Locale, Bundle> = {
  "en": {
    "wizard.welcome": "✨ Welcome to miki-moni! First-time setup.",
    "wizard.pick.language": "Which language?",
    "wizard.pick.relay": "How should phones reach the daemon?",
    "wizard.choice.hosted": "Hosted relay (recommended) — use relay.f1telemetrystationpro.org, zero setup",
    "wizard.choice.hosted.desc": "Free shared relay. Zero-knowledge — relay never sees your content.",
    "wizard.choice.selfhost": "Self-host — auto-deploy to your own Cloudflare account",
    "wizard.choice.selfhost.desc": "Needs CF account + wrangler. ~5 minutes. Fully independent.",
    "wizard.choice.local": "Local-only — only 127.0.0.1:8765 dashboard, no phone",
    "wizard.choice.local.desc": "Most secure, but no phone / cross-machine access.",
    "selfhost.intro.1": "I'll set up two things on your own Cloudflare account:",
    "selfhost.intro.2": "1. Relay server — the encrypted forwarding backend",
    "selfhost.intro.3": "2. Phone app — the web page your phone / second laptop opens",
    "selfhost.intro.4": "Both free; CF's free tier covers personal use.",
    "selfhost.wrangler.missing": "✗ wrangler (Cloudflare's deploy tool) not found.",
    "selfhost.wrangler.install": "  Install: npm install -g wrangler",
    "selfhost.wrangler.retry": "  Then re-run: miki setup",
    "selfhost.step1": "[1/3] Sign in to Cloudflare",
    "selfhost.step1.browser": "      Your browser will open for OAuth login…",
    "selfhost.step1.ok": "✓ Cloudflare login successful",
    "selfhost.step2": "[2/3] Deploying Relay server …",
    "selfhost.step2.multiacc": "⚠ Multiple Cloudflare accounts detected. Pick one:",
    "selfhost.step2.pickacc": "Which CF account?",
    "selfhost.step2.retry": "→ Retrying with account",
    "selfhost.step2.fail": "✗ Relay deploy failed. See wrangler output above; usually it's CF account permissions.",
    "selfhost.step2.ok": "✓ Relay deployed to",
    "selfhost.step2.urlfail": "but wrangler didn't print the workers.dev URL.",
    "selfhost.step2.urlinput": "Worker URL (https://...workers.dev):",
    "selfhost.step3": "[3/3] Deploying Phone app …",
    "selfhost.step3.fail": "✗ Phone app deploy failed.",
    "selfhost.step3.ok": "✓ Phone app deployed to",
    "selfhost.done.title": "✓ Done! Settings saved to ~/.miki-moni/config.json:",
    "banner.title": "📱 Phone pairing — scan QR, open URL, or type the 16-char code:",
    "banner.local": "Local: ",
    "banner.local.hint": "← Open on the same machine, no relay",
    "banner.permanent": "(QR / URL / Code are permanent — rotate with `miki pair --rotate`)",
  },
  "zh-TW": {
    "wizard.welcome": "✨ 歡迎使用 miki-moni！首次設定。",
    "wizard.pick.language": "請選語言：",
    "wizard.pick.relay": "配對手機要透過哪條路徑連回 daemon？",
    "wizard.choice.hosted": "Hosted relay（推薦） — 用 relay.f1telemetrystationpro.org，零設定",
    "wizard.choice.hosted.desc": "免費共用 relay。Zero-knowledge — relay 看不到你內容。99% 使用者選這個。",
    "wizard.choice.selfhost": "Self-host — 自動部署到你的 Cloudflare 帳號",
    "wizard.choice.selfhost.desc": "需要 CF 帳號 + wrangler。約 5 分鐘。完全自主，不依賴作者基礎設施。",
    "wizard.choice.local": "Local-only — 只用 127.0.0.1:8765 dashboard，不配手機",
    "wizard.choice.local.desc": "完全本機。安全度最高，但手機 / 跨機器無法用。",
    "selfhost.intro.1": "我會幫你在你自己的 Cloudflare 帳號上開兩個東西：",
    "selfhost.intro.2": "1. Relay server — 轉發加密訊息的後端",
    "selfhost.intro.3": "2. Phone app    — 手機 / 第二台電腦開的網頁",
    "selfhost.intro.4": "完全免費，CF 免費層額度足夠個人用。",
    "selfhost.wrangler.missing": "✗ 找不到 wrangler（Cloudflare 的部署工具）。",
    "selfhost.wrangler.install": "  請先跑：npm install -g wrangler",
    "selfhost.wrangler.retry": "  然後重來：miki setup",
    "selfhost.step1": "[1/3] 登入 Cloudflare",
    "selfhost.step1.browser": "      瀏覽器即將開啟，請完成 OAuth 登入…",
    "selfhost.step1.ok": "✓ Cloudflare 登入成功",
    "selfhost.step2": "[2/3] 部署 Relay server …",
    "selfhost.step2.multiacc": "⚠ 偵測到你有多個 Cloudflare 帳號，請選一個來部署：",
    "selfhost.step2.pickacc": "用哪個 CF 帳號？",
    "selfhost.step2.retry": "→ 用帳號重新部署",
    "selfhost.step2.fail": "✗ Relay 部署失敗。看上面的 wrangler 訊息找原因；常見是 CF 帳號權限不足。",
    "selfhost.step2.ok": "✓ Relay 已部署到",
    "selfhost.step2.urlfail": "但 wrangler 沒印出 workers.dev URL。",
    "selfhost.step2.urlinput": "Worker URL (https://...workers.dev):",
    "selfhost.step3": "[3/3] 部署 Phone app …",
    "selfhost.step3.fail": "✗ Phone app 部署失敗。",
    "selfhost.step3.ok": "✓ Phone app 已部署到",
    "selfhost.done.title": "✓ 完成！設定已存進 ~/.miki-moni/config.json：",
    "banner.title": "📱 Phone pairing — scan QR, open URL, or type the 16-char code:",
    "banner.local": "Local: ",
    "banner.local.hint": "← 同台電腦在這看 dashboard，不走 relay",
    "banner.permanent": "(QR / URL / Code 是永久 — `miki pair --rotate` 可換)",
  },
  "zh-CN": {
    "wizard.welcome": "✨ 欢迎使用 miki-moni！首次设置。",
    "wizard.pick.language": "请选语言：",
    "wizard.pick.relay": "手机配对要走哪条路径连回 daemon？",
    "wizard.choice.hosted": "Hosted relay（推荐） — 用 relay.f1telemetrystationpro.org，零设置",
    "wizard.choice.hosted.desc": "免费共用 relay。Zero-knowledge — relay 看不到你内容。",
    "wizard.choice.selfhost": "Self-host — 自动部署到你自己的 Cloudflare 账号",
    "wizard.choice.selfhost.desc": "需要 CF 账号 + wrangler。约 5 分钟。完全自主。",
    "wizard.choice.local": "Local-only — 只用 127.0.0.1:8765 dashboard，不连手机",
    "wizard.choice.local.desc": "最安全，但手机 / 跨设备无法用。",
    "selfhost.intro.1": "我会在你自己的 Cloudflare 账号上开两个东西：",
    "selfhost.intro.2": "1. Relay server — 转发加密消息的后端",
    "selfhost.intro.3": "2. Phone app    — 手机 / 第二台电脑打开的网页",
    "selfhost.intro.4": "完全免费，CF 免费层额度够个人用。",
    "selfhost.wrangler.missing": "✗ 找不到 wrangler（Cloudflare 的部署工具）。",
    "selfhost.wrangler.install": "  请先跑：npm install -g wrangler",
    "selfhost.wrangler.retry": "  然后重来：miki setup",
    "selfhost.step1": "[1/3] 登录 Cloudflare",
    "selfhost.step1.browser": "      浏览器即将打开，请完成 OAuth 登录…",
    "selfhost.step1.ok": "✓ Cloudflare 登录成功",
    "selfhost.step2": "[2/3] 部署 Relay server …",
    "selfhost.step2.multiacc": "⚠ 检测到你有多个 Cloudflare 账号，请选一个：",
    "selfhost.step2.pickacc": "用哪个 CF 账号？",
    "selfhost.step2.retry": "→ 用账号重新部署",
    "selfhost.step2.fail": "✗ Relay 部署失败。看上面 wrangler 输出找原因；通常是 CF 账号权限不足。",
    "selfhost.step2.ok": "✓ Relay 已部署到",
    "selfhost.step2.urlfail": "但 wrangler 没打印 workers.dev URL。",
    "selfhost.step2.urlinput": "Worker URL (https://...workers.dev):",
    "selfhost.step3": "[3/3] 部署 Phone app …",
    "selfhost.step3.fail": "✗ Phone app 部署失败。",
    "selfhost.step3.ok": "✓ Phone app 已部署到",
    "selfhost.done.title": "✓ 完成！设置已存进 ~/.miki-moni/config.json：",
    "banner.title": "📱 手机配对 — 扫 QR、打开 URL，或输入 16 位码：",
    "banner.local": "Local: ",
    "banner.local.hint": "← 同台电脑在这看 dashboard，不走 relay",
    "banner.permanent": "(QR / URL / Code 永久 — `miki pair --rotate` 可换)",
  },
};

let active: Locale = (process.env.MIKI_LOCALE as Locale) ?? "en";

export function setLocale(l: Locale): void {
  active = l;
}

export function getLocale(): Locale {
  return active;
}

export function t(key: string): string {
  return LOCALES[active]?.[key] ?? LOCALES.en[key] ?? key;
}

export const LOCALE_CHOICES: Array<{ name: string; value: Locale }> = [
  { name: "English", value: "en" },
  { name: "繁體中文 (Traditional Chinese)", value: "zh-TW" },
  { name: "简体中文 (Simplified Chinese)", value: "zh-CN" },
];
