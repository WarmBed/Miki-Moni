// ── i18n: zh-TW / zh-CN / en ───────────────────────────────────────────────
//
// Lightweight i18n for the cc-hub web dashboard. Three locales, single source
// of truth = zh-TW (matches the original hardcoded strings). Locale is
// persisted to localStorage; first-load fallback inspects navigator.language.
//
// Public surface:
//   - useLocale()          : Preact hook → [locale, setLocale]
//   - t("key", params?)    : translate; params interpolate "{name}" tokens
//   - LOCALES, LOCALE_LABELS
//
// Components re-render on locale change via a tiny pub/sub on the module
// scope (so we don't have to thread a Context through every component).

import { useEffect, useState } from "preact/hooks";

export type Locale = "zh-TW" | "zh-CN" | "en";

export const LOCALES: readonly Locale[] = ["zh-TW", "zh-CN", "en"] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  "en":    "English",
};

const LS_KEY = "miki-moni:locale";

function detectInitial(): Locale {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === "zh-TW" || raw === "zh-CN" || raw === "en") return raw;
  } catch { /* disabled */ }
  try {
    const nav = (navigator.language || "").toLowerCase();
    if (nav.startsWith("zh-cn") || nav.startsWith("zh-hans") || nav === "zh") return "zh-CN";
    if (nav.startsWith("zh")) return "zh-TW";
    if (nav.startsWith("en")) return "en";
  } catch { /* SSR / no navigator */ }
  return "zh-TW";
}

let currentLocale: Locale = detectInitial();
const subs = new Set<(l: Locale) => void>();

export function getLocale(): Locale { return currentLocale; }
export function setLocale(l: Locale): void {
  if (l === currentLocale) return;
  currentLocale = l;
  try { localStorage.setItem(LS_KEY, l); } catch { /* quota / disabled */ }
  subs.forEach((fn) => fn(l));
}

export function useLocale(): [Locale, (l: Locale) => void] {
  const [l, setL] = useState<Locale>(currentLocale);
  useEffect(() => {
    const fn = (next: Locale) => setL(next);
    subs.add(fn);
    return () => { subs.delete(fn); };
  }, []);
  return [l, setLocale];
}

// ── Dictionaries ───────────────────────────────────────────────────────────
// Flat dotted keys for trivial lookup. zh-TW is the source; zh-CN and en
// mirror the exact same key set. Missing keys fall back to the key string
// itself so a typo never crashes a render.

type Dict = Record<string, string>;

const zhTW: Dict = {
  // status
  "status.active":  "進行中",
  "status.waiting": "等你回應",
  "status.idle":    "閒置",
  "status.stale":   "已斷線",

  // time-ago
  "time.secondsAgo": "{n} 秒前",
  "time.minutesAgo": "{n} 分鐘前",
  "time.hoursAgo":   "{n} 小時前",
  "time.daysAgo":    "{n} 天前",

  // ask card
  "ask.atLeastOne":   "請至少回答一題",
  "ask.claudeAsking": "❓ Claude 在問你問題",
  "ask.placeholder":  "或自己打答案（會跟勾選一起送）…",
  "ask.prev":         "← 上一題",
  "ask.next":         "下一題 →",
  "ask.submitting":   "送出中…",
  "ask.submit":       "Submit",
  "ask.removeThis":   "移除這張",

  // tool-use expand toggles
  "expand.collapse":   "收合",
  "expand.expandIn":   "展開 IN",
  "expand.expandOut":  "展開 OUT",
  "expand.expand":     "展開",

  // transcript
  "transcript.empty":           "(transcript 沒有可顯示的訊息)",
  "transcript.conversation":    "對話",
  "transcript.countItems":      "{n} 條",
  "transcript.fileSize":        "{kb} KB",
  "transcript.lastModified":    "最後修改 {time}",
  "transcript.showTool":        "顯示 TOOL",
  "transcript.items10":         "10 條",
  "transcript.items20":         "20 條",
  "transcript.items50":         "50 條",
  "transcript.items100":        "100 條",
  "transcript.items200":        "200 條",
  "transcript.items500":        "500 條",
  "transcript.itemsAll":        "全部",
  "transcript.loadAll":         "📜 載入全部",
  "transcript.loadAllTitle":    "把整個 session JSONL 全部讀進來（最多 10000 turn）",
  "transcript.loading":         "讀取中…",
  "transcript.reload":          "重新讀取",

  // send / focus result
  "send.focusing":      "叫起視窗：{label}",
  "send.httpOk":        "OK · HTTP {status}",
  "send.httpFail":      "失敗 HTTP {status}",
  "send.claudeReplied": "Claude 已回覆 ({ms} ms)",
  "send.sentToVSCode":  "已送出到 VSCode panel（Enter 已自動按）",
  "send.sendFailed":    "送出失敗：{label}",

  // focus / wrapper badges
  "focus.cliNotSupported": "🚫 CLI session 不支援 focus（URI handler 只開 VSCode）",
  "focus.bringVSCode":     "叫起 VSCode 視窗（focus）",
  "focus.wrappedBadge":    "🔌 wrapped",
  "focus.wrappedTitle":    "wrapper 接管中（CLI session）",
  "focus.wrapperRunning":  "wrapper 正在: {activity}",

  // composer
  "composer.imageIgnored":        "⚠️ 圖片在這個 session 模式下會被忽略（只有 wrapped 才能傳圖）",
  "composer.cliNotWrapped":       "CLI session 沒接管 — 先在 terminal 跑：miki claude -r {short}…",
  "composer.vscodeDisabledWrap":  "VSCode panel mode 已停用 — 請改用 wrap：miki claude -r {short}…",
  "composer.vscodeDisabledWrap2": "VSCode panel mode 已停用 — 請改 wrap：miki claude -r {short}…",
  "composer.inputPrompt":         "輸入 prompt（Ctrl+V 可貼圖）→ push 進 wrapper 的 query()…",
  "composer.interruptLong":       "中斷目前 Claude 的回應（呼叫 SDK Query.interrupt()）",
  "composer.interruptShort":      "中斷目前 Claude 的回應",
  "composer.needWrapHint":        "先 `miki claude -r <uuid>` 接管 (wrap-cli)",
  "composer.needWrapHint2":       "請先 `miki claude -r <uuid>` 接管 (wrap-cli)",
  "composer.wrapWSHint":          "走 wrap WS push 進 terminal 的 query()（免費，可帶圖）",
  "composer.wrapWSShort":         "走 wrap WS push 進 terminal 的 query()",
  "composer.needWrapBadge":       "需 wrap",
  "composer.cliPanelNotWrapped":  "📟",
  "composer.cliNotWrappedStrong": "CLI session 沒接管",
  "composer.pleaseUse":            "：請改用",
  "composer.toTakeOver":           "接管。",
  "composer.advancedToggle":       "advanced：切換送出模式",
  "composer.headlessReal":         "真送出模式（headless `claude -r -p`，會花 API 費用、不走你 panel session）",
  "composer.keyEnter":             "Enter 送出 · Shift+Enter 換行",
  "composer.keyCtrlEnter":         "⌘/Ctrl+Enter 送出 · Enter 換行",
  "composer.escClose":             " · Esc 關閉",
  "composer.sendBusy":             "⌛",
  "composer.sendWrapped":          "送出 🔌",
  "composer.sendNeedWrap":         "送出 (需 wrap)",

  // header / stats
  "header.all":           "全覽",
  "header.live":          "進行中",
  "header.idle":          "閒置",
  "header.stale":         "已斷線",
  "header.onlyShow":      "只看 {label}",
  "header.running":       "目前正在運行",
  "header.filtered":      "· 已過濾 ({filter}) · 點 TOTAL 重設",
  "header.liveLong":      "進行中 / 等回應",
  "header.wsConnected":   "WS connected",
  "header.wsConnecting":  "connecting…",
  "header.wsDisconnected":"WS disconnected",
  "header.settingsBtn":   "⚙️ 設定",
  "header.settingsTitle": "設定",

  // session card / row
  "session.copyRestart":      "複製重啟指令：pnpm --dir D:\\code\\cc-hub miki claude -r {uuid}",
  "session.cliMarkTooltip":   "標記為 CLI session — 預填送出已停用（URI handler 不支援 terminal）。點一下改回 VSCode。",
  "session.vscodeMarkTooltip":"標記為 VSCode session — 點一下改成 CLI。",
  "session.waitingBadge":     "🔔 待回應",
  "session.waitingTooltip":   "Claude 還在等你回答 — 點開重新顯示問題",
  "session.openTab":          "開到 tab",
  "session.wrappedDetailed":  "這個 session 被 `miki claude` wrapper 接管（CLI session）— 送出走 push、不再 spawn / 不花 $$",
  "session.empty":            "(尚未開始對話)",
  "session.quickSend":        "快速送出（彈出小卡片，不展開 transcript）",
  "session.openCli":          "開 CLI",
  "session.openCliPending":   "...",
  "session.openCliFailed":    "失敗：{err}",
  "session.openCliTooltip":   "彈一個 Windows Terminal 跑 miki claude -r — 把這個 session 變成 wrapped",
  "wrapNotice.title":         "CLI 已啟動 — 請手動關閉 VSCode panel",
  "wrapNotice.body":          "{project} 現在被 CLI wrapper 接管。VSCode panel 還是「擁有」這個 session 的話，兩邊各打字會把 JSONL 切成分支、session 狀態就糊了。建議：把 VSCode 那個 Claude Code panel 關掉，之後只用 dashboard / CLI 互動。",
  "wrapNotice.confirmCheck":  "我已關閉對應的 VSCode panel",
  "wrapNotice.confirm":       "確認",
  "wrapNotice.later":         "稍後處理",
  "wrapNotice.dismiss":       "知道了",
  "header.newCli":            "新增 CLI",
  "header.newCliTitle":       "在指定資料夾開新的 CLI（miki claude --fresh）",
  "newCli.heading":           "新增 CLI",
  "newCli.cwdLabel":          "資料夾路徑",
  "newCli.cwdPlaceholder":    "路徑",
  "newCli.recentCwds":        "最近用過的路徑",
  "newCli.submit":            "開啟",
  "newCli.submitting":        "啟動中…",
  "newCli.success":           "已啟動 — 等 wrap 連回 daemon",
  "newCli.error":             "失敗：{err}",
  "newCli.hint":              "會在新的 Windows Terminal 裡跑 miki claude --fresh。先送一句 \"hi\" 啟動 SDK 後接管。",
  "session.closeTab":         "關閉 tab",
  "session.closeKey":         "關閉",
  "session.modalClose":       "關閉 (Esc)",
  "session.claudeWaitingHere":"🔔 Claude 還在等你回答這個 session 的問題",
  "session.showQuestion":     "重新顯示問題",

  // permission modes (locked tooltips + menu rows)
  "mode.lockedAcceptTitle": "Auto-accept edits mode：所有 edit/write 直接套用、不再確認。`miki claude --permission-mode acceptEdits` 啟動鎖定。",
  "mode.lockedBypassTitle": "Bypass permissions：所有工具都不問就執行。極度危險，僅在 sandbox 使用。`miki claude --bypass-permissions` 啟動鎖定。",
  "mode.lockedPlanTitle":   "Plan mode：只規劃、不執行 mutation 類工具。`miki claude --permission-mode plan` 啟動鎖定。",
  "mode.defaultDesc":       "每次 edit 都問你",
  "mode.defaultTitle":      "Ask before edits：每個 mutation 工具會問你。",
  "mode.acceptDesc":        "Edit / write 直接套用",
  "mode.acceptTitle":       "Edit automatically：所有 edit/write 直接套用、不再確認。",
  "mode.planDesc":          "只規劃、不動檔案",
  "mode.planTitle":         "Plan mode：只規劃、不執行 mutation 類工具。",
  "mode.autoDesc":          "Claude 自己挑 mode",
  "mode.autoTitle":         "Auto mode：Claude 自動依任務選最適合的 mode。",
  "mode.bypassDesc":        "全部工具直接跑（危險）",
  "mode.bypassTitle":       "Bypass permissions：所有工具都不問就執行。極度危險，只在 sandbox 使用。",
  "mode.switchHint":        " · 點一下切換 mode",

  // log panel
  "log.activity":       "活動紀錄",
  "log.syncedConsole":  "同步輸出到 F12 Console",
  "log.clear":          "清空",
  "log.empty":          "尚無活動，按任何按鈕或等 hook 事件就會冒出來。",

  // overview / empty states
  "overview.title":          "🗺️ 全覽",
  "overview.noSessions":     "目前沒有 session。",
  "overview.openPanelHint":  "在任何 VSCode 視窗開 Claude Code panel 就會冒出來。",
  "overview.runHooks":       "沒反應的話：",
  "overview.sessionGone":    "(session 不存在了，可能 daemon 重啟過)",

  // settings panel
  "settings.title":              "設定",
  "settings.sendKeySection":     "送出鍵（全域）",
  "settings.enterLabel":         "Enter",
  "settings.enterDesc":          " 送出 ·  Shift+Enter 換行",
  "settings.ctrlEnterLabel":     "Ctrl/⌘ + Enter",
  "settings.ctrlEnterDesc":      " 送出 · Enter 換行",
  "settings.sendKeyHelp":        "套用到 dashboard 快速送出視窗 + 每個 tab 的 composer。Enter 模式下仍可用 Ctrl/⌘+Enter 強制送出。",
  "settings.appearance":         "外觀",
  "settings.themeLight":         "☀️ Light",
  "settings.themeDark":          "🌙 Dark",
  "settings.themeSystem":        "🖥 System",
  "settings.themeSystemTitle":   "跟隨 OS 設定（prefers-color-scheme）",
  "settings.themeDarkTitle":     "深色模式",
  "settings.themeLightTitle":    "淺色模式",
  "settings.sortMode":           "卡片排序",
  "settings.sortPriorityLabel":  "🔔 優先級",
  "settings.sortPriorityTitle":  "需要回應的 session 優先（waiting → active → idle → stale），同組內依 cwd 排序",
  "settings.sortUuidLabel":      "🆔 UUID 序",
  "settings.sortUuidTitle":      "依 session_uuid 排序；每個 session 永遠卡同一格，F5 / 重啟都不會位移（位置與專案名無關）",
  "settings.sortRecentLabel":    "⏱ 最近活動",
  "settings.sortRecentTitle":    "最近有事件的排前面（last_event_at DESC），會隨活動跳動",
  "settings.sortHelp":           "影響首頁卡片順序。F5 後位置會記住（除了「最近活動」模式，這個本來就會隨活動移動）。",
  "settings.close":              "關閉",
  "settings.language":           "語言",

  // startup logs
  "startup.starting":          "啟動 — 抓 /sessions + previews",
  "startup.getSessionsFailed": "GET /sessions 失敗",
  "startup.gotSessions":       "GET /sessions 200 — 收到 {n} 個 session",
  "startup.wsConnecting":      "WS 連線中",
};

const zhCN: Dict = {
  "status.active":  "进行中",
  "status.waiting": "等你回应",
  "status.idle":    "闲置",
  "status.stale":   "已断线",

  "time.secondsAgo": "{n} 秒前",
  "time.minutesAgo": "{n} 分钟前",
  "time.hoursAgo":   "{n} 小时前",
  "time.daysAgo":    "{n} 天前",

  "ask.atLeastOne":   "请至少回答一题",
  "ask.claudeAsking": "❓ Claude 在问你问题",
  "ask.placeholder":  "或自己打答案（会跟勾选一起送）…",
  "ask.prev":         "← 上一题",
  "ask.next":         "下一题 →",
  "ask.submitting":   "送出中…",
  "ask.submit":       "Submit",
  "ask.removeThis":   "移除这张",

  "expand.collapse":  "收合",
  "expand.expandIn":  "展开 IN",
  "expand.expandOut": "展开 OUT",
  "expand.expand":    "展开",

  "transcript.empty":           "(transcript 没有可显示的讯息)",
  "transcript.conversation":    "对话",
  "transcript.countItems":      "{n} 条",
  "transcript.fileSize":        "{kb} KB",
  "transcript.lastModified":    "最后修改 {time}",
  "transcript.showTool":        "显示 TOOL",
  "transcript.items10":         "10 条",
  "transcript.items20":         "20 条",
  "transcript.items50":         "50 条",
  "transcript.items100":        "100 条",
  "transcript.items200":        "200 条",
  "transcript.items500":        "500 条",
  "transcript.itemsAll":        "全部",
  "transcript.loadAll":         "📜 加载全部",
  "transcript.loadAllTitle":    "把整个 session JSONL 全部读进来（最多 10000 turn）",
  "transcript.loading":         "读取中…",
  "transcript.reload":          "重新读取",

  "send.focusing":      "叫起窗口：{label}",
  "send.httpOk":        "OK · HTTP {status}",
  "send.httpFail":      "失败 HTTP {status}",
  "send.claudeReplied": "Claude 已回复 ({ms} ms)",
  "send.sentToVSCode":  "已送出到 VSCode panel（Enter 已自动按）",
  "send.sendFailed":    "送出失败：{label}",

  "focus.cliNotSupported": "🚫 CLI session 不支持 focus（URI handler 只开 VSCode）",
  "focus.bringVSCode":     "叫起 VSCode 窗口（focus）",
  "focus.wrappedBadge":    "🔌 wrapped",
  "focus.wrappedTitle":    "wrapper 接管中（CLI session）",
  "focus.wrapperRunning":  "wrapper 正在: {activity}",

  "composer.imageIgnored":        "⚠️ 图片在这个 session 模式下会被忽略（只有 wrapped 才能传图）",
  "composer.cliNotWrapped":       "CLI session 没接管 — 先在 terminal 跑：miki claude -r {short}…",
  "composer.vscodeDisabledWrap":  "VSCode panel mode 已停用 — 请改用 wrap：miki claude -r {short}…",
  "composer.vscodeDisabledWrap2": "VSCode panel mode 已停用 — 请改 wrap：miki claude -r {short}…",
  "composer.inputPrompt":         "输入 prompt（Ctrl+V 可贴图）→ push 进 wrapper 的 query()…",
  "composer.interruptLong":       "中断目前 Claude 的回应（呼叫 SDK Query.interrupt()）",
  "composer.interruptShort":      "中断目前 Claude 的回应",
  "composer.needWrapHint":        "先 `miki claude -r <uuid>` 接管 (wrap-cli)",
  "composer.needWrapHint2":       "请先 `miki claude -r <uuid>` 接管 (wrap-cli)",
  "composer.wrapWSHint":          "走 wrap WS push 进 terminal 的 query()（免费，可带图）",
  "composer.wrapWSShort":         "走 wrap WS push 进 terminal 的 query()",
  "composer.needWrapBadge":       "需 wrap",
  "composer.cliPanelNotWrapped":  "📟",
  "composer.cliNotWrappedStrong": "CLI session 没接管",
  "composer.pleaseUse":            "：请改用",
  "composer.toTakeOver":           "接管。",
  "composer.advancedToggle":       "advanced：切换送出模式",
  "composer.headlessReal":         "真送出模式（headless `claude -r -p`，会花 API 费用、不走你 panel session）",
  "composer.keyEnter":             "Enter 送出 · Shift+Enter 换行",
  "composer.keyCtrlEnter":         "⌘/Ctrl+Enter 送出 · Enter 换行",
  "composer.escClose":             " · Esc 关闭",
  "composer.sendBusy":             "⌛",
  "composer.sendWrapped":          "送出 🔌",
  "composer.sendNeedWrap":         "送出 (需 wrap)",

  "header.all":           "全览",
  "header.live":          "进行中",
  "header.idle":          "闲置",
  "header.stale":         "已断线",
  "header.onlyShow":      "只看 {label}",
  "header.running":       "目前正在运行",
  "header.filtered":      "· 已过滤 ({filter}) · 点 TOTAL 重设",
  "header.liveLong":      "进行中 / 等回应",
  "header.wsConnected":   "WS connected",
  "header.wsConnecting":  "connecting…",
  "header.wsDisconnected":"WS disconnected",
  "header.settingsBtn":   "⚙️ 设置",
  "header.settingsTitle": "设置",

  "session.copyRestart":       "复制重启指令：pnpm --dir D:\\code\\cc-hub miki claude -r {uuid}",
  "session.cliMarkTooltip":    "标记为 CLI session — 预填送出已停用（URI handler 不支持 terminal）。点一下改回 VSCode。",
  "session.vscodeMarkTooltip": "标记为 VSCode session — 点一下改成 CLI。",
  "session.waitingBadge":      "🔔 待回应",
  "session.waitingTooltip":    "Claude 还在等你回答 — 点开重新显示问题",
  "session.openTab":           "开到 tab",
  "session.wrappedDetailed":   "这个 session 被 `miki claude` wrapper 接管（CLI session）— 送出走 push、不再 spawn / 不花 $$",
  "session.empty":             "(尚未开始对话)",
  "session.quickSend":         "快速送出（弹出小卡片，不展开 transcript）",
  "session.openCli":           "开 CLI",
  "session.openCliPending":    "...",
  "session.openCliFailed":     "失败：{err}",
  "session.openCliTooltip":    "弹一个 Windows Terminal 跑 miki claude -r — 把这个 session 变成 wrapped",
  "wrapNotice.title":          "CLI 已启动 — 请手动关闭 VSCode panel",
  "wrapNotice.body":           "{project} 现在被 CLI wrapper 接管。VSCode panel 还是「拥有」这个 session 的话，两边各打字会把 JSONL 切成分支、session 状态就糊了。建议：把 VSCode 那个 Claude Code panel 关掉，之后只用 dashboard / CLI 互动。",
  "wrapNotice.confirmCheck":   "我已关闭对应的 VSCode panel",
  "wrapNotice.confirm":        "确认",
  "wrapNotice.later":          "稍后处理",
  "wrapNotice.dismiss":        "知道了",
  "header.newCli":             "新增 CLI",
  "header.newCliTitle":        "在指定文件夹开新的 CLI（miki claude --fresh）",
  "newCli.heading":            "新增 CLI",
  "newCli.cwdLabel":           "文件夹路径",
  "newCli.cwdPlaceholder":     "路径",
  "newCli.recentCwds":         "最近用过的路径",
  "newCli.submit":             "开启",
  "newCli.submitting":         "启动中…",
  "newCli.success":            "已启动 — 等 wrap 连回 daemon",
  "newCli.error":              "失败：{err}",
  "newCli.hint":               "会在新的 Windows Terminal 里跑 miki claude --fresh。先送一句 \"hi\" 启动 SDK 后接管。",
  "session.closeTab":          "关闭 tab",
  "session.closeKey":          "关闭",
  "session.modalClose":        "关闭 (Esc)",
  "session.claudeWaitingHere": "🔔 Claude 还在等你回答这个 session 的问题",
  "session.showQuestion":      "重新显示问题",

  "mode.lockedAcceptTitle": "Auto-accept edits mode：所有 edit/write 直接套用、不再确认。`miki claude --permission-mode acceptEdits` 启动锁定。",
  "mode.lockedBypassTitle": "Bypass permissions：所有工具都不问就执行。极度危险，仅在 sandbox 使用。`miki claude --bypass-permissions` 启动锁定。",
  "mode.lockedPlanTitle":   "Plan mode：只规划、不执行 mutation 类工具。`miki claude --permission-mode plan` 启动锁定。",
  "mode.defaultDesc":       "每次 edit 都问你",
  "mode.defaultTitle":      "Ask before edits：每个 mutation 工具会问你。",
  "mode.acceptDesc":        "Edit / write 直接套用",
  "mode.acceptTitle":       "Edit automatically：所有 edit/write 直接套用、不再确认。",
  "mode.planDesc":          "只规划、不动文件",
  "mode.planTitle":         "Plan mode：只规划、不执行 mutation 类工具。",
  "mode.autoDesc":          "Claude 自己挑 mode",
  "mode.autoTitle":         "Auto mode：Claude 自动依任务选最适合的 mode。",
  "mode.bypassDesc":        "全部工具直接跑（危险）",
  "mode.bypassTitle":       "Bypass permissions：所有工具都不问就执行。极度危险，只在 sandbox 使用。",
  "mode.switchHint":        " · 点一下切换 mode",

  "log.activity":      "活动记录",
  "log.syncedConsole": "同步输出到 F12 Console",
  "log.clear":         "清空",
  "log.empty":         "尚无活动，按任何按钮或等 hook 事件就会冒出来。",

  "overview.title":         "🗺️ 全览",
  "overview.noSessions":    "目前没有 session。",
  "overview.openPanelHint": "在任何 VSCode 窗口开 Claude Code panel 就会冒出来。",
  "overview.runHooks":      "没反应的话：",
  "overview.sessionGone":   "(session 不存在了，可能 daemon 重启过)",

  "settings.title":             "设置",
  "settings.sendKeySection":    "送出键（全局）",
  "settings.enterLabel":        "Enter",
  "settings.enterDesc":         " 送出 ·  Shift+Enter 换行",
  "settings.ctrlEnterLabel":    "Ctrl/⌘ + Enter",
  "settings.ctrlEnterDesc":     " 送出 · Enter 换行",
  "settings.sendKeyHelp":       "应用到 dashboard 快速送出窗口 + 每个 tab 的 composer。Enter 模式下仍可用 Ctrl/⌘+Enter 强制送出。",
  "settings.appearance":        "外观",
  "settings.themeLight":        "☀️ Light",
  "settings.themeDark":         "🌙 Dark",
  "settings.themeSystem":       "🖥 System",
  "settings.themeSystemTitle":  "跟随 OS 设置（prefers-color-scheme）",
  "settings.themeDarkTitle":    "深色模式",
  "settings.themeLightTitle":   "浅色模式",
  "settings.sortMode":          "卡片排序",
  "settings.sortPriorityLabel": "🔔 优先级",
  "settings.sortPriorityTitle": "需要回应的 session 优先（waiting → active → idle → stale），同组内依 cwd 排序",
  "settings.sortUuidLabel":     "🆔 UUID 序",
  "settings.sortUuidTitle":     "依 session_uuid 排序；每个 session 永远卡同一格，F5 / 重启都不会位移（位置与项目名无关）",
  "settings.sortRecentLabel":   "⏱ 最近活动",
  "settings.sortRecentTitle":   "最近有事件的排前面（last_event_at DESC），会随活动跳动",
  "settings.sortHelp":          "影响首页卡片顺序。F5 后位置会记住（除了「最近活动」模式，这个本来就会随活动移动）。",
  "settings.close":             "关闭",
  "settings.language":          "语言",

  "startup.starting":          "启动 — 抓 /sessions + previews",
  "startup.getSessionsFailed": "GET /sessions 失败",
  "startup.gotSessions":       "GET /sessions 200 — 收到 {n} 个 session",
  "startup.wsConnecting":      "WS 连线中",
};

const en: Dict = {
  "status.active":  "Active",
  "status.waiting": "Awaiting you",
  "status.idle":    "Idle",
  "status.stale":   "Disconnected",

  "time.secondsAgo": "{n}s ago",
  "time.minutesAgo": "{n}m ago",
  "time.hoursAgo":   "{n}h ago",
  "time.daysAgo":    "{n}d ago",

  "ask.atLeastOne":   "Please answer at least one question",
  "ask.claudeAsking": "❓ Claude is asking you a question",
  "ask.placeholder":  "Or type your own answer (sent with the checked options)…",
  "ask.prev":         "← Prev",
  "ask.next":         "Next →",
  "ask.submitting":   "Submitting…",
  "ask.submit":       "Submit",
  "ask.removeThis":   "Remove this",

  "expand.collapse":  "Collapse",
  "expand.expandIn":  "Expand IN",
  "expand.expandOut": "Expand OUT",
  "expand.expand":    "Expand",

  "transcript.empty":           "(no displayable messages in transcript)",
  "transcript.conversation":    "Conversation",
  "transcript.countItems":      "{n}",
  "transcript.fileSize":        "{kb} KB",
  "transcript.lastModified":    "Last modified {time}",
  "transcript.showTool":        "Show TOOL",
  "transcript.items10":         "10",
  "transcript.items20":         "20",
  "transcript.items50":         "50",
  "transcript.items100":        "100",
  "transcript.items200":        "200",
  "transcript.items500":        "500",
  "transcript.itemsAll":        "All",
  "transcript.loadAll":         "📜 Load all",
  "transcript.loadAllTitle":    "Load the entire session JSONL (up to 10000 turns)",
  "transcript.loading":         "Loading…",
  "transcript.reload":          "Reload",

  "send.focusing":      "Focus window: {label}",
  "send.httpOk":        "OK · HTTP {status}",
  "send.httpFail":      "Failed HTTP {status}",
  "send.claudeReplied": "Claude replied ({ms} ms)",
  "send.sentToVSCode":  "Sent to VSCode panel (Enter auto-pressed)",
  "send.sendFailed":    "Send failed: {label}",

  "focus.cliNotSupported": "🚫 CLI session does not support focus (URI handler only opens VSCode)",
  "focus.bringVSCode":     "Bring up VSCode window (focus)",
  "focus.wrappedBadge":    "🔌 wrapped",
  "focus.wrappedTitle":    "Wrapper has taken over (CLI session)",
  "focus.wrapperRunning":  "wrapper running: {activity}",

  "composer.imageIgnored":        "⚠️ Images are ignored in this session mode (only wrapped sessions accept images)",
  "composer.cliNotWrapped":       "CLI session not wrapped — first run in terminal: miki claude -r {short}…",
  "composer.vscodeDisabledWrap":  "VSCode panel mode disabled — please wrap instead: miki claude -r {short}…",
  "composer.vscodeDisabledWrap2": "VSCode panel mode disabled — please wrap: miki claude -r {short}…",
  "composer.inputPrompt":         "Type prompt (Ctrl+V to paste image) → push into wrapper's query()…",
  "composer.interruptLong":       "Interrupt current Claude response (calls SDK Query.interrupt())",
  "composer.interruptShort":      "Interrupt current Claude response",
  "composer.needWrapHint":        "First `miki claude -r <uuid>` to take over (wrap-cli)",
  "composer.needWrapHint2":       "Please `miki claude -r <uuid>` to take over (wrap-cli)",
  "composer.wrapWSHint":          "Use wrap WS push into terminal's query() (free, supports images)",
  "composer.wrapWSShort":         "Use wrap WS push into terminal's query()",
  "composer.needWrapBadge":       "needs wrap",
  "composer.cliPanelNotWrapped":  "📟",
  "composer.cliNotWrappedStrong": "CLI session not wrapped",
  "composer.pleaseUse":            ": please use",
  "composer.toTakeOver":           " to take over.",
  "composer.advancedToggle":       "advanced: toggle send mode",
  "composer.headlessReal":         "Real send mode (headless `claude -r -p`, costs API $$ and bypasses your panel session)",
  "composer.keyEnter":             "Enter to send · Shift+Enter for newline",
  "composer.keyCtrlEnter":         "⌘/Ctrl+Enter to send · Enter for newline",
  "composer.escClose":             " · Esc to close",
  "composer.sendBusy":             "⌛",
  "composer.sendWrapped":          "Send 🔌",
  "composer.sendNeedWrap":         "Send (needs wrap)",

  "header.all":           "All",
  "header.live":          "Live",
  "header.idle":          "Idle",
  "header.stale":         "Disconnected",
  "header.onlyShow":      "Only show {label}",
  "header.running":       "Currently running",
  "header.filtered":      "· filtered ({filter}) · click TOTAL to reset",
  "header.liveLong":      "Live / awaiting",
  "header.wsConnected":   "WS connected",
  "header.wsConnecting":  "connecting…",
  "header.wsDisconnected":"WS disconnected",
  "header.settingsBtn":   "⚙️ Settings",
  "header.settingsTitle": "Settings",

  "session.copyRestart":       "Copy restart command: pnpm --dir D:\\code\\cc-hub miki claude -r {uuid}",
  "session.cliMarkTooltip":    "Marked as CLI session — prefilled send is disabled (URI handler doesn't support terminal). Click to switch back to VSCode.",
  "session.vscodeMarkTooltip": "Marked as VSCode session — click to switch to CLI.",
  "session.waitingBadge":      "🔔 Awaiting reply",
  "session.waitingTooltip":    "Claude is still waiting for your answer — click to re-show the question",
  "session.openTab":           "Open in tab",
  "session.wrappedDetailed":   "This session is taken over by the `miki claude` wrapper (CLI session) — sends go via push, no spawn / no $$",
  "session.empty":             "(no conversation yet)",
  "session.quickSend":         "Quick send (pops a small card, no transcript expand)",
  "session.openCli":           "Open CLI",
  "session.openCliPending":    "...",
  "session.openCliFailed":     "Failed: {err}",
  "session.openCliTooltip":    "Pop a Windows Terminal running miki claude -r — turns this session into a wrapped one",
  "wrapNotice.title":          "CLI started — please close the VSCode panel manually",
  "wrapNotice.body":           "{project} is now owned by the CLI wrapper. The VSCode panel still thinks it owns this session — typing in both will fork the JSONL transcript and corrupt session state. Recommended: close that Claude Code panel in VSCode, then interact only via dashboard / CLI.",
  "wrapNotice.confirmCheck":   "I've closed the corresponding VSCode panel",
  "wrapNotice.confirm":        "Confirm",
  "wrapNotice.later":          "Cancel",
  "wrapNotice.dismiss":        "Got it",
  "header.newCli":             "New CLI",
  "header.newCliTitle":        "Open a new CLI in a chosen folder (miki claude --fresh)",
  "newCli.heading":            "New CLI",
  "newCli.cwdLabel":           "Folder path",
  "newCli.cwdPlaceholder":     "Path",
  "newCli.recentCwds":         "Recent paths",
  "newCli.submit":             "Open",
  "newCli.submitting":         "Starting…",
  "newCli.success":            "Started — waiting for wrap to connect back",
  "newCli.error":              "Failed: {err}",
  "newCli.hint":               "Spawns miki claude --fresh in a new Windows Terminal. SDK initializes via a synthetic \"hi\" then takes over.",
  "session.closeTab":          "Close tab",
  "session.closeKey":          "Close",
  "session.modalClose":        "Close (Esc)",
  "session.claudeWaitingHere": "🔔 Claude is still waiting for your answer on this session",
  "session.showQuestion":      "Re-show question",

  "mode.lockedAcceptTitle": "Auto-accept edits mode: all edits/writes apply directly, no confirmation. Locked at start via `miki claude --permission-mode acceptEdits`.",
  "mode.lockedBypassTitle": "Bypass permissions: all tools run without asking. Extremely dangerous, sandbox only. Locked at start via `miki claude --bypass-permissions`.",
  "mode.lockedPlanTitle":   "Plan mode: planning only, no mutation tools. Locked at start via `miki claude --permission-mode plan`.",
  "mode.defaultDesc":       "Ask before every edit",
  "mode.defaultTitle":      "Ask before edits: every mutation tool prompts you.",
  "mode.acceptDesc":        "Apply edits / writes directly",
  "mode.acceptTitle":       "Edit automatically: all edits/writes apply directly, no confirmation.",
  "mode.planDesc":          "Plan only, no file changes",
  "mode.planTitle":         "Plan mode: planning only, no mutation tools.",
  "mode.autoDesc":          "Claude picks the mode itself",
  "mode.autoTitle":         "Auto mode: Claude picks the most appropriate mode per task.",
  "mode.bypassDesc":        "All tools run (dangerous)",
  "mode.bypassTitle":       "Bypass permissions: all tools run without asking. Extremely dangerous, sandbox only.",
  "mode.switchHint":        " · click to switch mode",

  "log.activity":      "Activity log",
  "log.syncedConsole": "Mirrored to F12 Console",
  "log.clear":         "Clear",
  "log.empty":         "No activity yet. Hit any button or wait for hook events.",

  "overview.title":         "🗺️ Overview",
  "overview.noSessions":    "No sessions yet.",
  "overview.openPanelHint": "Open a Claude Code panel in any VSCode window — it shows up here.",
  "overview.runHooks":      "Nothing happening? Try:",
  "overview.sessionGone":   "(session no longer exists, daemon may have restarted)",

  "settings.title":             "Settings",
  "settings.sendKeySection":    "Send key (global)",
  "settings.enterLabel":        "Enter",
  "settings.enterDesc":         " to send · Shift+Enter for newline",
  "settings.ctrlEnterLabel":    "Ctrl/⌘ + Enter",
  "settings.ctrlEnterDesc":     " to send · Enter for newline",
  "settings.sendKeyHelp":       "Applies to the dashboard quick-send card + every tab's composer. In Enter mode, Ctrl/⌘+Enter still force-sends.",
  "settings.appearance":        "Appearance",
  "settings.themeLight":        "☀️ Light",
  "settings.themeDark":         "🌙 Dark",
  "settings.themeSystem":       "🖥 System",
  "settings.themeSystemTitle":  "Follow OS setting (prefers-color-scheme)",
  "settings.themeDarkTitle":    "Dark mode",
  "settings.themeLightTitle":   "Light mode",
  "settings.sortMode":          "Card sort",
  "settings.sortPriorityLabel": "🔔 Priority",
  "settings.sortPriorityTitle": "Sessions awaiting reply first (waiting → active → idle → stale), then by cwd",
  "settings.sortUuidLabel":     "🆔 UUID",
  "settings.sortUuidTitle":     "Sort by session_uuid; each session stays in its slot forever, no drift on F5/restart (independent of project name)",
  "settings.sortRecentLabel":   "⏱ Recent",
  "settings.sortRecentTitle":   "Most recent activity first (last_event_at DESC), shuffles as events arrive",
  "settings.sortHelp":          "Affects overview card ordering. Position persists across F5 (except for the Recent mode, which is meant to shuffle).",
  "settings.close":             "Close",
  "settings.language":          "Language",

  "startup.starting":          "Starting — fetching /sessions + previews",
  "startup.getSessionsFailed": "GET /sessions failed",
  "startup.gotSessions":       "GET /sessions 200 — received {n} sessions",
  "startup.wsConnecting":      "WS connecting",
};

const MESSAGES: Record<Locale, Dict> = {
  "zh-TW": zhTW,
  "zh-CN": zhCN,
  "en":    en,
};

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k];
    return v === undefined || v === null ? `{${k}}` : String(v);
  });
}

/**
 * Translate a flat dotted key against the current locale.
 * Missing key → falls back to zh-TW, then to the key string itself.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const tbl = MESSAGES[currentLocale];
  const raw = tbl[key] ?? MESSAGES["zh-TW"][key] ?? key;
  return interpolate(raw, params);
}
