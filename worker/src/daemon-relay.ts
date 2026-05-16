import type { Env } from "./env.js";
import {
  generateChallenge,
  buildChallengeMessage,
  toBase64,
  fromBase64,
  deriveDaemonId,
  CHALLENGE_TTL_MS,
  type Challenge,
} from "./handshake.js";
import nacl from "tweetnacl";

interface DaemonAttachment {
  role: "daemon";
  pubkey_b64: string;
  challenge?: Challenge;
  authed: boolean;
  daemon_id: string;
}

interface PhoneAttachment {
  role: "phone";
  phone_id: string;
  pairing_token?: string;
  authed: boolean;
}

type Attachment = DaemonAttachment | PhoneAttachment;

export class DaemonRelay implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/v1/daemon")) return this.acceptDaemon(req);
    if (url.pathname.endsWith("/v1/phone")) return this.acceptPhone(req);
    return new Response("not_found", { status: 404 });
  }

  private async acceptDaemon(req: Request): Promise<Response> {
    const pubkey_b64 = req.headers.get("X-Daemon-Pubkey");
    if (!pubkey_b64) return new Response("missing X-Daemon-Pubkey", { status: 400 });
    let pubkey: Uint8Array;
    try {
      pubkey = fromBase64(pubkey_b64);
      if (pubkey.length !== 32) throw new Error("bad length");
    } catch {
      return new Response("bad X-Daemon-Pubkey", { status: 400 });
    }
    const daemon_id = this.state.id.name ?? await deriveDaemonId(pubkey);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const challenge = generateChallenge();
    const att: DaemonAttachment = {
      role: "daemon", pubkey_b64,
      challenge, authed: false, daemon_id,
    };

    this.state.acceptWebSocket(server, ["daemon"]);
    server.serializeAttachment(att);

    server.send(JSON.stringify({
      type: "challenge",
      nonce: toBase64(challenge.nonce),
      issued_at_ms: challenge.issued_at_ms,
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptPhone(req: Request): Promise<Response> {
    const pairing_token = req.headers.get("X-Pairing-Token");
    const phone_pubkey_hdr = req.headers.get("X-Phone-Pubkey");
    const sig_hdr = req.headers.get("X-Sig");

    if (!pairing_token && !phone_pubkey_hdr) {
      return new Response("missing pairing_token or phone_pubkey", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    if (pairing_token) {
      const phone_id = pairing_token;
      const att: PhoneAttachment = { role: "phone", phone_id, pairing_token, authed: false };
      this.state.acceptWebSocket(server, ["phone", phone_id]);
      server.serializeAttachment(att);

      const daemonPubkey = await this.state.storage.get<string>("daemon_pubkey_b64");
      const pending = await this.state.storage.get<{ token: string; expires_at_ms: number }>("pending_pair");
      if (!daemonPubkey || !pending || pending.token !== pairing_token || Date.now() > pending.expires_at_ms) {
        server.close(4002, "pairing_token_invalid");
        return new Response(null, { status: 101, webSocket: client });
      }

      server.send(JSON.stringify({ type: "pair_init", daemon_pubkey: daemonPubkey }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Reconnect mode (sig verification)
    if (!phone_pubkey_hdr || !sig_hdr) {
      return new Response("missing phone_pubkey or sig", { status: 400 });
    }
    const phone_id = phone_pubkey_hdr;
    const att: PhoneAttachment = { role: "phone", phone_id, authed: false };
    this.state.acceptWebSocket(server, ["phone", phone_id]);
    server.serializeAttachment(att);
    const paired = await this.state.storage.get<Record<string, string>>("paired_phones");
    if (!paired || !paired[phone_pubkey_hdr]) {
      server.close(4001, "unknown_phone");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!this.verifyReconnectSig(phone_pubkey_hdr, sig_hdr)) {
      server.close(4001, "bad_sig");
      return new Response(null, { status: 101, webSocket: client });
    }
    att.authed = true;
    server.serializeAttachment(att);
    server.send(JSON.stringify({ type: "ready" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private verifyReconnectSig(phone_pubkey_b64: string, sig_b64: string): boolean {
    try {
      const pubkey = fromBase64(phone_pubkey_b64);
      const sig = fromBase64(sig_b64);
      const daemon_id = this.state.id.name!;
      const daemonIdBytes = new TextEncoder().encode(daemon_id);
      const nowMinute = Math.floor(Date.now() / 60_000);
      for (const m of [nowMinute, nowMinute - 1]) {
        const msg = new Uint8Array(daemonIdBytes.length + 8);
        msg.set(daemonIdBytes, 0);
        new DataView(msg.buffer, daemonIdBytes.length, 8).setBigUint64(0, BigInt(m), false);
        if (nacl.sign.detached.verify(msg, sig, pubkey)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Hibernating WebSocket handlers ────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | undefined;
    if (!att) { ws.close(1011, "no_attachment"); return; }
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: any;
    try { msg = JSON.parse(text); } catch { ws.close(1008, "bad_json"); return; }

    if (att.role === "daemon") return this.handleDaemonMessage(ws, att, msg);
    return this.handlePhoneMessage(ws, att, msg);
  }

  private async handleDaemonMessage(ws: WebSocket, att: DaemonAttachment, msg: any): Promise<void> {
    if (!att.authed) {
      if (msg.type !== "challenge_response") { ws.close(1008, "expected_challenge_response"); return; }
      const pubkey = fromBase64(att.pubkey_b64);
      const sig = fromBase64(msg.sig);
      const ch = att.challenge!;
      const sigMsg = buildChallengeMessage(ch.nonce, ch.issued_at_ms);
      if (Date.now() > ch.issued_at_ms + CHALLENGE_TTL_MS) { ws.close(4001, "challenge_expired"); return; }
      if (!nacl.sign.detached.verify(sigMsg, sig, pubkey)) { ws.close(4001, "bad_sig"); return; }
      att.authed = true;
      att.challenge = undefined;
      ws.serializeAttachment(att);
      await this.state.storage.put("daemon_pubkey_b64", att.pubkey_b64);
      ws.send(JSON.stringify({ type: "ready", daemon_id: att.daemon_id }));
      return;
    }

    if (msg.type === "register_pairing") {
      const token = String(msg.token ?? "");
      await this.state.storage.put("pending_pair", {
        token, expires_at_ms: Date.now() + 10 * 60 * 1000,
      });
      // Also tell the coordinator so phones can claim it
      if (this.env.PAIRING) {
        const coordId = this.env.PAIRING.idFromName("coordinator");
        const coordStub = this.env.PAIRING.get(coordId);
        await coordStub.fetch("https://x/register", {
          method: "POST",
          body: JSON.stringify({ token, daemon_id: att.daemon_id }),
          headers: { "content-type": "application/json" },
        });
      }
      return;
    }

    if (msg.type === "pair_ack") {
      for (const phone of this.state.getWebSockets("phone")) {
        const p = phone.deserializeAttachment() as PhoneAttachment;
        if (p && p.pairing_token) {
          phone.send(JSON.stringify({ type: "pair_ack" }));
          p.authed = true;
          p.pairing_token = undefined;
          phone.serializeAttachment(p);
        }
      }
      await this.state.storage.delete("pending_pair");
      return;
    }

    // envelope or other: broadcast to all authed phones
    for (const phone of this.state.getWebSockets("phone")) {
      const p = phone.deserializeAttachment() as PhoneAttachment;
      if (p && p.authed) phone.send(JSON.stringify(msg));
    }
  }

  private async handlePhoneMessage(ws: WebSocket, att: PhoneAttachment, msg: any): Promise<void> {
    if (!att.authed) {
      if (msg.type === "pair_offer" && att.pairing_token) {
        const pk = String(msg.phone_pubkey ?? "");
        const paired = (await this.state.storage.get<Record<string, string>>("paired_phones")) ?? {};
        paired[pk] = String(Date.now());
        await this.state.storage.put("paired_phones", paired);

        const daemon = this.daemonWs();
        if (daemon) daemon.send(JSON.stringify(msg));
        return;
      }
      ws.close(1008, "expected_pair_offer");
      return;
    }

    const daemon = this.daemonWs();
    if (!daemon) { ws.close(4011, "daemon_offline"); return; }
    daemon.send(JSON.stringify(msg));
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}
  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}

  private daemonWs(): WebSocket | null {
    const arr = this.state.getWebSockets("daemon");
    return arr[0] ?? null;
  }
}
