# cc-hub Pairing Protocol (v1)

## Goal

Securely establish a long-term X25519 shared secret between daemon and a phone, using the Worker only as a short-lived rendezvous. Worker never sees the shared secret.

## Flow

1. **User runs `pnpm pair --new` on the daemon machine.**
2. Daemon:
   - Generates a 16-byte random `pairing_token` (base64-encoded).
   - Connects to Worker `WSS /v1/daemon` with headers:
     - `X-Daemon-Auth: <token>`
     - `X-Pairing-Token: <pairing_token>` (no X-Daemon-Id during pairing)
   - Renders a QR code in the terminal containing this JSON:
     ```json
     {
       "worker_url": "wss://...",
       "pairing_token": "<base64>",
       "daemon_pk": "<base64 daemon long-term pubkey>",
       "name": "<device name>"
     }
     ```
3. **User scans the QR with phone.** Phone now has `worker_url`, `pairing_token`, `daemon_pk`, `name`.
4. Phone:
   - Generates (or retrieves stored) long-term keypair `(PPk, PSk)`.
   - Connects to Worker `WSS /v1/phone` with headers:
     - CF Access SSO (handled by Worker)
     - `X-Pairing-Token: <pairing_token>` (matches the daemon's)
   - Sends pairing message:
     ```json
     { "kind": "pair_offer", "phone_pk": "<base64 PPk>", "phone_name": "<device label>" }
     ```
     **During pairing, messages are sent as raw JSON, NOT inside encrypted envelopes** — neither side has a shared secret yet. The Worker is the only intermediary and is trusted only for the short pairing window.
5. Worker sees both daemon and phone connected with same `pairing_token` and routes the `pair_offer` to the daemon's WS.
6. Daemon:
   - Computes `shared_secret = curve25519(daemon_sk, PPk)`.
   - Persists `{peer_id, peer_name, peer_pubkey, shared_secret, paired_at}` to `~/.cc-hub/config.json` under `paired_peers[]`.
   - `peer_id = base64(sha256(peer_pubkey)).replace(/[+/=]/g, '').slice(0,16)`.
   - Sends an **encrypted** envelope back containing:
     ```json
     { "kind": "pair_ack", "ok": true }
     ```
     This serves as proof-of-possession: phone decrypts using its own `curve25519(phone_sk, daemon_pk)` → if it matches, pairing is confirmed.
7. Phone:
   - Receives the envelope, decrypts with its derived shared secret.
   - If decryption succeeds and `kind === "pair_ack"`, pairing is done.
   - Persists `{daemon_id, worker_url, shared_secret}` to local storage.
8. Both sides close the pairing-mode WS. Daemon will reconnect in **relay mode** on next event (Phase 1 already exists; Phase 2 daemon entry-point starts RelayClient automatically when `paired_peers.length > 0`).

## Pairing Token TTL

5 minutes. After expiry, daemon closes WS and exits the pairing flow. User runs `pnpm pair --new` again.

## Failure Modes

| Failure | Daemon behaviour | Phone behaviour |
|---|---|---|
| QR not scanned within 5 min | Print "Pairing timed out", exit 1 | N/A |
| Phone connects but never sends `pair_offer` | Wait until TTL, then timeout | User cancels |
| `pair_offer` malformed | Drop, wait for next or timeout | Show error |
| `pair_ack` decryption fails on phone side | Daemon thinks it succeeded; phone retries / shows error | Retry pairing |
| Network drop mid-pairing | Close WS, timeout | Retry |

## Security Notes

- The pairing token is **only a rendezvous identifier**. Possession of it does NOT grant pairing — knowledge of the daemon's pubkey (from QR) is the real shared knowledge.
- An attacker who controls the Worker AND gets the pairing token can attempt a MITM: substitute their own pubkey in the QR. **Mitigation**: phone displays a fingerprint of the daemon_pk after pairing; user can compare with daemon's terminal output. (Not implemented in v0.3; deferred to Phase 3.)
- After pairing, the `shared_secret` is the only proof-of-identity. Loss of phone → revoke via `pnpm pair --revoke <peer_id>` on daemon.
