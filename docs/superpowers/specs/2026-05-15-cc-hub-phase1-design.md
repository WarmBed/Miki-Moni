# cc-hub — Phase 1 設計文件

**日期**: 2026-05-15
**作者**: mike + Claude
**狀態**: Draft，等 user review

## 一句話定義

一個跑在本機的常駐 daemon，把同時開的多個 VSCode Claude Code panel session 收攏成單一儀表板，可以看狀態、收通知、一鍵跳到對的視窗、預填 prompt 給某個 session。

## 解決什麼

User 同時開 3 個 VSCode 各自跑不同專案（openruterati / dragonfly / ...），每個 VSCode 都有 Claude Code panel。實際痛點：

1. 不知道哪個 Claude 在等回應、哪個還在跑、哪個爆錯了
2. 切窗成本高，常常某個 Claude 等了 10 分鐘才發現
3. 想統一管理 token 用量、狀態歷史

**Phase 1 不解決**：手機/外網真遠端、自動送出 prompt、跨 session context 共享。這些之後另開 spec。

## 已知約束

來自 Anthropic 官方文件與社群實作的驗證：

| 約束 | 對設計的影響 |
|---|---|
| 官方 Remote Control 只支援 CLI 模式，不支援 VSCode panel ([Issue #30905](https://github.com/anthropics/claude-code/issues/30905)) | 沒得繞，必須自己蓋 |
| `vscode://anthropic.claude-code/open?session=<id>&prompt=<encoded>` URI handler 可以叫起特定 session 並預填 prompt，但**不自動送出** | Phase 1 接受「預填後手動按 Enter」的限制 |
| Hooks（settings.json）在 panel 模式照樣觸發 | 監控走 hook，最穩 |
| Session 對話紀錄寫在 `~/.claude/projects/<encoded-cwd>/*.jsonl` | 反查 session UUID 的單一可信來源 |
| 內建 `PushNotification` 工具可推 desktop + （將來）手機 | 通知層不用自己造 |

## 架構

```
┌──────────────────────────────────────────────────────┐
│  cc-hub (Node.js daemon, listens on 127.0.0.1:8765)  │
│   ├─ HTTP API    POST /event, GET /sessions,         │
│   │              POST /focus, POST /send             │
│   ├─ WebSocket   /ws  (推 live update 給 Web UI)     │
│   ├─ Web UI      靜態 SPA，掛在 /                    │
│   └─ SQLite      ~/.cc-hub/state.db                  │
└──────────────────────────────────────────────────────┘
       ▲                              │
       │ POST events                  │ 開 vscode:// URI（Start-Process）
       │                              ▼
┌──────┴──────────┐  ┌──────────────┐  ┌──────────────┐
│ ~/.claude/      │  │ VSCode #1    │  │ VSCode #2    │
│ settings.json   │  │ openruterati │  │ dragonfly    │
│ hooks 呼 PS 腳本 │  │ Claude panel │  │ Claude panel │
└─────────────────┘  └──────────────┘  └──────────────┘
```

## 元件

每個檔案職責單一、可獨立測試。

| 檔案 | 職責 | 依賴 |
|---|---|---|
| `src/server.ts` | HTTP + WebSocket server，路由分發 | express, ws |
| `src/session-store.ts` | session 狀態的純資料層（CRUD + query） | better-sqlite3 |
| `src/hook-handler.ts` | 解析 hook payload → 推論狀態變化 → 寫 store | session-store |
| `src/session-resolver.ts` | 從 cwd 反查 `~/.claude/projects/<encoded>/*.jsonl` 找 sessionUuid | fs |
| `src/vscode-bridge.ts` | 包裝 `vscode://...` URI 呼叫（Windows `Start-Process`） | child_process |
| `src/notifier.ts` | 呼叫 Claude Code 內建 PushNotification | （MCP？或 IPC？實作時驗證） |
| `web/index.html` + `web/app.ts` | 單頁 dashboard | preact 或 vanilla |
| `hooks/cc-hub-emit.ps1` | settings.json 引用的小腳本，把 hook payload POST 給 daemon | （內建 PS） |

## 資料模型（session-store）

```ts
type SessionStatus = "active" | "waiting" | "idle" | "stale";

interface Session {
  // 主鍵：cwd 是穩定識別（log file 反查用）
  cwd: string;                  // e.g. "d:\\code\\dragonfly"
  
  // 對話真實識別（從 log file 取得，給 URI handler 用）
  session_uuid: string | null;  // null 表示還沒 resolve 出來
  
  // 顯示用
  project_name: string;         // path basename
  status: SessionStatus;
  last_event_at: number;        // unix ms
  last_message_preview: string; // 最近一則 assistant message 截 80 字
  
  // 統計（先簡單）
  tokens_in: number;
  tokens_out: number;
  
  // 來源 hook
  vscode_pid: number | null;    // 之後 focus 用得到
}
```

## API

```
POST /event                # hook 來電（payload schema 見下）
GET  /sessions             # 列出所有 session
GET  /sessions/:cwd        # 單一 session 詳細
POST /focus  {cwd}         # 叫起對的 VSCode 視窗
POST /send   {cwd, prompt} # 開 URI handler 預填 prompt
WS   /ws                   # 廣播 session 變化
```

Hook payload（PowerShell 腳本要組這個）：

```json
{
  "event_type": "session_start" | "stop" | "user_prompt" | "pre_tool_use" | "post_tool_use",
  "cwd": "d:\\code\\dragonfly",
  "session_uuid": "<從 env CLAUDE_SESSION_ID 或 null>",
  "timestamp": 1715760000000,
  "extra": { /* event-specific */ }
}
```

實作時驗證：`CLAUDE_SESSION_ID` 環境變數是否在 hook 內可拿到。若不行，靠 `session-resolver.ts` 從 log file 反查。

## 資料流

**場景 A：cross-window 通知 + focus**
1. dragonfly 的 Claude 停下 → `Stop` hook 跑 `cc-hub-emit.ps1`
2. POST `/event {type: "stop", cwd: "d:\\code\\dragonfly"}`
3. `hook-handler` 更新 store status = "waiting"
4. WebSocket 廣播 → dashboard 卡片變黃
5. `notifier` 推 desktop notification「dragonfly 在等你」
6. user 點 dashboard 卡片 → POST `/focus {cwd}` → daemon 用 `session-resolver` 拿到 session_uuid → `Start-Process "vscode://...open?session=<uuid>"` → 對的視窗跳前景

**場景 B：dashboard 預填 prompt**
1. user 在 dashboard 卡片下方輸入框打「跑測試」+ 按送
2. POST `/send {cwd, prompt:"跑測試"}`
3. `vscode-bridge` 組 URL：`vscode://anthropic.claude-code/open?session=<uuid>&prompt=%E8%B7%91%E6%B8%AC%E8%A9%A6`
4. `Start-Process` 開該 URI → VSCode 視窗跳前景，prompt 已預填
5. user 確認後按 Enter

## 錯誤處理

| 情境 | 處理 |
|---|---|
| daemon 沒開但 hook 觸發 | PS 腳本用 `try/catch -ErrorAction SilentlyContinue`，fail silent 不擋 Claude |
| 同一個 cwd 多次重複事件 | last-write-wins by timestamp，store 用 UPSERT |
| session 已關，URI handler 失敗 | daemon 標記 status = "stale"，下次心跳更正 |
| port 8765 被佔 | 落到 8766/8767...，寫到 `~/.cc-hub/port` 檔，PS 腳本讀檔取 port |
| session_uuid resolve 不到 | focus/send 退化成只 focus 一般 vscode 視窗（不帶 session），仍比啥都不做好 |
| 重複 send 同 prompt | 不去重（URI handler 不會自動送出，重複叫起只是蓋掉預填內容） |

## 測試策略

依 [feedback_development_workflow](C:\\Users\\mike2\\.claude\\projects\\d--code\\memory\\feedback_development_workflow.md) 走 TDD。

- **Unit (vitest)**: `session-store`, `hook-handler`, `session-resolver` — 純邏輯、no IO（IO 走 fixture）
- **Integration**: 起 daemon 行程 → 假 POST 一連串 events → assert SQLite state + WS broadcast
- **Manual smoke**: 開兩個 VSCode panel，跑下面 checklist：
  - dragonfly Claude 停下 → dashboard 卡片變黃 + 收到通知
  - 點 focus → dragonfly 視窗跳前景
  - 在 dashboard 送 prompt → prompt 預填到對的視窗
- 不做 e2e VSCode 自動化（不值得，panel 沒法 headless）。CI 跑前兩層即可。

## 技術棧（預設）

- **Runtime**: Node.js 20+ (使用 user 的 openruterati / dragonfly 同款 TS toolchain)
- **Language**: TypeScript strict
- **DB**: better-sqlite3 (同步 API、單檔、無 server，適合本機)
- **HTTP/WS**: express + ws (簡單夠用)
- **Web UI**: preact + tailwind（極小 bundle，user 不需要 React 那堆儀式；若實作時 preact 路徑卡住，fallback vanilla TS + tailwind）
- **Test**: vitest
- **Logging**: pino (jsonl 到 `~/.cc-hub/cc-hub.log`)

## 安裝 / 啟動（user 視角）

```powershell
# 1. clone + install
cd d:\code\cc-hub
pnpm install
pnpm build

# 2. 啟動 daemon（先做 foreground，背景化 Phase 2 再說）
pnpm start

# 3. 在 ~/.claude/settings.json 加 hooks 區段（cc-hub 提供範本指令）
pnpm install:hooks

# 4. 開瀏覽器
start http://localhost:8765
```

## YAGNI 清單（**不**做的事）

- ❌ 帳號管理 / cc-switch 那類功能（已有現成）
- ❌ 雲端 sync（Phase 2/3）
- ❌ 手機 PWA（Phase 2）
- ❌ Claude session 之間的協調 / 鎖機制（Phase 4，超難，先確認 Phase 1 真的有用再說）
- ❌ Claude API token 用量計費（如要做之後再加）
- ❌ 對話歷史 search / replay（已有 VSCode 內建 session history）
- ❌ 跨機器多 daemon 聚合

## Open Questions（實作時要驗）

1. Hook 環境變數有沒有 `CLAUDE_SESSION_ID`？若有，省一道 log file 反查
2. `Stop` hook payload 長啥樣（要看實際 jsonl example）
3. VSCode 在 Windows 開 `vscode://` URI 時是否會把對的視窗 raise 前景（理論上是，要驗）
4. `PushNotification` 工具在 daemon Node 程式裡怎麼呼叫（是 MCP？是 CLI subcommand？文件沒寫清）
5. 多 VSCode 視窗 + 同一個 workspace 路徑時，URI handler 行為（會 focus 哪一個？）

這 5 個 Phase 1 計劃實作時逐一驗證；任何一個如果擋住，會回頭調整 spec。

## 下一步

User 看完這份 spec → 同意/改 → 我用 writing-plans skill 把它拆成可執行的 implementation plan。
