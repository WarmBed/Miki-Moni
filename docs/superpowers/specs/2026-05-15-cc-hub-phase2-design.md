# cc-hub Phase 2 — End-to-End Encrypted Remote Access via Cloudflare Worker

**日期**: 2026-05-15
**作者**: mike + Claude
**狀態**: Draft，等 user review
**目標版本**: v0.3.0
**依賴**: Phase 1 (v0.1.0) 已完成

## 一句話定義

讓手機/瀏覽器透過 Cloudflare Worker 中轉去看 + 控制本機 cc-hub session，**Worker 看不到 prompt 內容**——它只搬密文。同款 threat model 與 Signal / happy-coder。

## 解決什麼

Phase 1 daemon 綁 127.0.0.1。要從外面（手機、咖啡廳的筆電）摸到本機 cc-hub，現在需要：
- 不能開 inbound port（家用網路 NAT / 防火牆）
- 不能信任中轉設施（即使是自己寫的 Worker 也應該假設它會被滲透）
- 配對流程要簡單（QR scan 一次完成）

## 工作分工

| 元件 | 誰寫 |
|---|---|
| 本機 daemon 的 RelayClient + 加密 + 配對 + CLI | **這個 spec 涵蓋的範圍（我做）** |
| Cloudflare Worker（公開入口、CF Access SSO、WS pubsub） | 你做 |
| 手機 / 瀏覽器 web UI | 你做（之後可能複用 Phase 1 的 preact UI） |
| Protocol 文件 | 我寫，雙方對接 |

## 威脅模型

**信任**：
- 你的手機（持有 paired keypair）
- daemon 跑的那台電腦（持有 paired keypair）
- 配對時看著終端機 QR 的人就是你

**不信任**：
- Cloudflare Worker（即使是你自己的 Worker code 也可能被滲透 / log 出 bug）
- CF infrastructure 本身
- 網路上任何中間人

**結論**：Worker 看到的 100% 密文。Worker 被攻破不會洩漏 prompt / session 內容。

## 加密設計

- **TweetNaCl**（NaCl 的 JS port，跟 Signal / happy 一樣）
- 每台 device（daemon、phone）有一組 **X25519 長期 keypair**（Curve25519）
- 配對時透過 Worker 交換公鑰，雙方各自算出 **shared secret**（curve25519 ECDH）
- 之後所有訊息用 `nacl.secretbox`（xsalsa20 + poly1305）加密，nonce 24 byte 隨機
- Replay 保護：receiver 維護 60 秒 nonce window，重複 nonce 丟棄

**不做**：
- ❌ Forward secrecy（Double Ratchet 太複雜，Phase 3+ 再說）
- ❌ Post-compromise security（同上）
- ❌ Group messaging

## 配對流程（pairing handshake）

```
1. 你跑：pnpm pair --new

2. daemon 端：
   - 產生 pairing_token T（16 byte 隨機，5 分鐘 TTL）
   - 從 config 拿 daemon 的長期 public key Pk
   - 終端機印出 QR，內容 JSON:
       { worker_url, pairing_token: T, daemon_pk: Pk, name: "mike2-pc" }
   - 同時 daemon 對 Worker 開 WS，header: X-Pairing-Token: T

3. 你手機掃 QR → phone 拿到 worker_url + T + Pk + name
   - phone 產生（或讀本地存的）長期 keypair (PPk, PSk)
   - phone 對 Worker WS 連線，header: X-Pairing-Token: T

4. Worker 看到兩邊都用同一個 T 連上 → 自動配對這兩條 WS

5. phone 送：{ type: "pair_offer", phone_pk: PPk, phone_name: "iPhone 15" }
   （這是配對前的 plaintext，但 Worker 不會 log message bodies）

6. daemon 收到 phone_pk → 算 shared_secret = curve25519(daemon_sk, PPk)
   - 寫進 ~/.cc-hub/config.json 的 paired_peers[]：
       { phone_id: hash(PPk), phone_pk: PPk, phone_name, shared_secret, paired_at }

7. daemon 用 shared_secret 加密回 { type: "pair_ack", ok: true } 送回去
   - phone 也算 shared_secret = curve25519(phone_sk, Pk)
   - phone 解密 pair_ack → 配對成功
   - phone 存：{ daemon_id: hash(Pk), worker_url, shared_secret } 到 localStorage

8. 兩邊都刪掉 ephemeral pairing 狀態，pairing_token T 作廢
```

**Pairing token TTL 5 分鐘**。過期需要重新跑 `pnpm pair --new`。

**支援多 device**：`paired_peers[]` 是陣列，你可以同時 pair 手機 + 平板 + 瀏覽器。

## Worker 合約（你寫 Worker，這是它必須做的）

### Endpoints

```
WSS  /v1/daemon           daemon 用這條
WSS  /v1/phone            phone / browser 用這條
GET  /v1/health           (optional) 健康檢查
```

### `/v1/daemon` WS handshake

- Header `X-Daemon-Auth: <pre-shared-anti-abuse-token>`（在 Worker 環境變數設、daemon 從 config 讀）
- 這個 token **不是用來 E2E auth** 的，純粹是防止外部人 spam Worker WS quota
- Header `X-Pairing-Token` 出現時 → 進入配對模式（短期）
- Header `X-Daemon-Id: <pubkey-hash>` 出現時 → 進入 relay 模式（已配對）

### `/v1/phone` WS handshake

- **Cloudflare Access SSO** required（Worker 檢 `CF-Access-Authenticated-User-Email` header）
- 你在 CF Access dashboard 設 SSO（Google / GitHub）並把該 Worker 加進保護範圍
- Header `X-Pairing-Token` 出現時 → 配對模式
- Header `X-Daemon-Id` + `X-Phone-Id` 出現時 → relay 模式

### Routing 邏輯

Worker 唯一要做的事：把訊息從一邊轉到另一邊。

```js
// 簡化版 Worker 邏輯
// 維護一個 Map<daemon_id, { daemonWs, phoneWss: Set }>
on('message', (fromWs, data) => {
  // 不解析 data 內容，就是把整個 envelope 轉發
  if (fromWs === daemonWs) {
    for (const phone of phoneWss) phone.send(data);
  } else {
    daemonWs.send(data);
  }
});
```

### Worker 必須做到

- ✅ 路由 WS 訊息
- ✅ 強制 CF Access 在 phone-side
- ✅ 強制 X-Daemon-Auth header 在 daemon-side
- ✅ 配對中轉（短期儲存 pairing_token → WS pair）
- ❌ **不可** log message bodies（只能 log timestamp、direction、size）
- ❌ **不可** 解析 envelope 內容
- ❌ **不可** 永久存任何訊息

## Envelope（過 Worker 的訊息格式）

```json
{
  "v": 1,
  "to": "daemon" | "phone:<id>",
  "ct": "<base64 ciphertext from nacl.secretbox>",
  "nonce": "<base64 24-byte>",
  "ts": 1715760000000
}
```

`ct` 解密後（用 paired shared_secret）拿到 plaintext 訊息。

## 訊息類型（plaintext payload）

### Upstream（daemon → phone）

```json
// 單筆 session 變化
{ "kind": "event", "session": { ...Session } }

// phone 請求後的完整 snapshot
{ "kind": "state_snapshot", "sessions": [ ...Session ] }

// keepalive 回應
{ "kind": "pong", "echo": "<random>" }
```

### Downstream（phone → daemon）

```json
{ "kind": "cmd_focus", "cwd": "d:\\code\\dragonfly" }
{ "kind": "cmd_send", "cwd": "d:\\code\\dragonfly", "prompt": "跑測試" }
{ "kind": "request_snapshot" }
{ "kind": "ping", "echo": "<random>" }
```

### 雙向

```json
// 配對階段
{ "kind": "pair_offer", "phone_pk": "...", "phone_name": "..." }
{ "kind": "pair_ack", "ok": true }
{ "kind": "pair_reject", "reason": "..." }
```

## 元件

| 檔案 | 職責 |
|---|---|
| `src/crypto.ts` | TweetNaCl 包裝：keypair gen、box/secretbox encrypt/decrypt、derive shared secret |
| `src/config.ts` | `~/.cc-hub/config.json` CRUD（device keypair、worker_url、paired_peers[]、x_daemon_auth_token） |
| `src/pairing.ts` | 配對狀態機 + QR 生成（用 `qrcode-terminal`） |
| `src/relay-protocol.ts` | Message type 定義、kind dispatcher |
| `src/relay-client.ts` | Outbound WS 到 Worker、自動 reconnect with exp backoff、加解密 envelope、派遣 kind → store / bridge |
| `src/cli/pair.ts` | `pnpm pair [--new \| --list \| --revoke <id>]` CLI |
| `src/index.ts`（修改） | 讀 config → 若 worker_url + 至少一個 paired peer 存在 → 啟動 RelayClient |
| `docs/protocols/relay-protocol.md` | Wire spec 給 Worker 對接 |
| `docs/protocols/pairing-protocol.md` | 配對 handshake spec |
| `docs/protocols/worker-skeleton.md` | Worker 實作骨架（給你抄的） |

## 資料模型擴充

`~/.cc-hub/config.json`：

```ts
interface Config {
  device: {
    name: string;             // "mike2-pc"
    pubkey: string;           // base64
    privkey: string;          // base64
    created_at: number;
  };
  remote?: {
    worker_url: string;       // "wss://cc-hub.<your-zone>.workers.dev"
    x_daemon_auth_token: string; // anti-abuse token, 從 Worker env var 拿
  };
  paired_peers: Array<{
    peer_id: string;          // base64(sha256(peer_pubkey)).slice(0,16)
    peer_name: string;        // "iPhone 15 Pro"
    peer_pubkey: string;      // base64
    shared_secret: string;    // base64, derived once
    paired_at: number;
    last_seen_at: number | null;
  }>;
}
```

## 資料流

### A. 首次配對（你+手機）
1. `pnpm pair --new`
2. daemon 印 QR，連 Worker `/v1/daemon` with `X-Pairing-Token`
3. 你手機掃 QR、開 Worker phone web、連 `/v1/phone` with 同 token
4. Worker 配對兩條 WS（短期 5 分鐘）
5. phone 送 `pair_offer`、daemon 算 shared secret + 存 config
6. daemon 加密 `pair_ack`、phone 解密確認
7. 雙方升級到「relay 模式」（用 `X-Daemon-Id` + `X-Phone-Id`）

### B. 一般使用（已配對後）
1. daemon 啟動 → 讀 config → 若有 paired peer → 連 Worker `/v1/daemon` (relay 模式)
2. daemon 訂 `store.session_changed` → 對每個 paired peer 用對應 shared_secret 加密 → 送 envelope 給 Worker
3. Worker 把 envelope 轉給目前連線的 phone WSs
4. phone 解密 → 更新 UI
5. phone 按「focus dragonfly」→ 加密 `cmd_focus` envelope → 送給 Worker → 轉給 daemon
6. daemon 解密 → 呼叫 `VscodeBridge.focus()`

### C. daemon 斷線重連
- RelayClient 用 exponential backoff（1s, 2s, 4s, 8s, max 60s）
- 連上後送一個 `state_snapshot`（一次性同步，避免 phone 端 stale）

### D. Revoke 配對
- `pnpm pair --revoke <peer_id>` → 從 config 移除 → 對該 peer 的訊息不再加密發送
- Worker 端不需通知（peer 自己連不上就會發現）

## 錯誤處理

| 情境 | 處理 |
|---|---|
| Worker 不通 | RelayClient 持續重試；UI 沒影響（Phase 1 dashboard 照常 work） |
| Pairing token 過期 | Worker 回 close code 4001；daemon 中止配對；user 重跑 `pnpm pair --new` |
| 解密失敗（nonce 重複 / mac 不對） | drop message + log warning + 不回 error（避免 oracle） |
| 收到未配對 peer 的訊息 | drop + log |
| Config 檔案損毀 | daemon refuse to start, print rescue 指示（編輯 / 從 backup 還原） |
| paired peer 太多（>10） | accept，不設上限，但 `pnpm pair --list` 提醒 |

## 測試策略

- **Unit (vitest)**：
  - `crypto.test.ts`：keypair round-trip、encrypt/decrypt round-trip、wrong-key 失敗、nonce-window
  - `config.test.ts`：load/save、損毀檔處理、migration（v0.1 → v0.3）
  - `pairing.test.ts`：state machine 完整流程、token expiry、replay 攻擊
  - `relay-protocol.test.ts`：envelope encode/decode、kind dispatcher
- **Integration**：
  - 用兩個 in-process daemon 假裝 daemon + phone，中間 mock Worker（純 echo server）
  - 跑完整配對 → 加密訊息往返 → cmd 派遣
- **Manual smoke**：
  - 真的部署 Worker（你寫好之後）
  - 配對手機
  - 觀察 dashboard 從手機看得到 + 能下指令

## 技術棧（新增）

- `tweetnacl` ^1.0.3 — NaCl crypto
- `tweetnacl-util` ^0.15.1 — base64 helpers
- `qrcode-terminal` ^0.12.0 — CLI QR 渲染

## YAGNI（**不**做的事）

- ❌ Forward secrecy / Double Ratchet（Phase 3+）
- ❌ 多 daemon 一個 user（同一個 user 多台機）
- ❌ Offline message queue（phone 不在線就 drop）
- ❌ 訊息歷史在 Worker 留存（Worker 是 pure pubsub）
- ❌ Group / sharing 給其他 user
- ❌ 自寫 SSO（CF Access 接手）
- ❌ daemon-to-daemon 對講（不是這個 spec 要解決的）

## Open Questions（實作時要驗）

1. `tweetnacl` 在 preact bundle 大小（要看 phone web 端能不能接受；如果太大、bundle splitting）
2. CF Access SSO 對 WS upgrade 的 header 注入行為（要試）
3. `qrcode-terminal` 在 Windows PowerShell 的渲染是否糊掉
4. Worker WS Durable Object vs Hibernation：你 Worker 端會處理，這 spec 不限定

## 下一步

User 看完 spec → approve → 我用 `writing-plans` skill 拆 implementation plan → subagent-driven execute。

預估 task 數：8-10 個（比 Phase 1 少，因為基礎建設 reuse Phase 1 那套）。
