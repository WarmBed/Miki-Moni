import { encrypt, decrypt } from "./crypto.js";
import type { Session } from "./types.js";

export const PROTOCOL_VERSION = 1;

export interface Envelope {
  v: number;
  to: string;       // "daemon" | `phone:${peer_id}`
  ct: string;       // base64
  nonce: string;    // base64 (24 bytes)
  ts: number;       // sender unix ms
}

// Plaintext kinds (after decryption)
export type Plaintext =
  | { kind: "event"; session: Session }
  | { kind: "state_snapshot"; sessions: Session[] }
  | { kind: "cmd_focus"; session_uuid?: string; cwd?: string }
  | { kind: "cmd_send"; session_uuid?: string; cwd?: string; prompt: string }
  | { kind: "request_snapshot" }
  | { kind: "ping"; echo: string }
  | { kind: "pong"; echo: string }
  | { kind: "pair_offer"; phone_pk: string; phone_name: string }
  | { kind: "pair_ack"; ok: boolean }
  | { kind: "pair_reject"; reason: string }
  // ─── Remote RPC tunnel — phone & remote-web clients proxy local server.ts ───
  | { kind: "http_proxy"; request_id: string; method: string; path: string; headers?: Record<string, string>; body?: string }
  | { kind: "http_proxy_response"; request_id: string; status: number; headers: Record<string, string>; body: string }
  | { kind: "ws_proxy_open"; tunnel_ws_id: string; path: string }
  | { kind: "ws_proxy_opened"; tunnel_ws_id: string }
  | { kind: "ws_proxy_msg"; tunnel_ws_id: string; data: string }
  | { kind: "ws_proxy_send"; tunnel_ws_id: string; data: string }
  | { kind: "ws_proxy_close"; tunnel_ws_id: string; code?: number; reason?: string };

export function encodeEnvelope(
  plaintext: Plaintext,
  sharedSecret: Uint8Array,
  to: string,
): Envelope {
  const json = JSON.stringify(plaintext);
  const { ct, nonce } = encrypt(json, sharedSecret);
  return { v: PROTOCOL_VERSION, to, ct, nonce, ts: Date.now() };
}

export function decodeEnvelope(env: Envelope, sharedSecret: Uint8Array): Plaintext | null {
  if (env.v !== PROTOCOL_VERSION) return null;
  const json = decrypt(env.ct, env.nonce, sharedSecret);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.kind !== "string") return null;
    return parsed as Plaintext;
  } catch {
    return null;
  }
}
