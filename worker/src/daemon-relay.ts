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
  pubkey_b64: string;          // Ed25519 signing pubkey (challenge-response + daemon_id derivation)
  enc_pubkey_b64?: string;     // X25519 encryption pubkey (sent to phones for ECDH in pair_init)
  challenge?: Challenge;
  authed: boolean;
  daemon_id: string;
}

interface PhoneAttachment {
  role: "phone";
  phone_id: string;                  // signing pubkey b64 (reconnect-mode auth + revoke_self routing)
  peer_id?: string;                  // computePeerId(encryption_pubkey) — addresses daemon→phone envelopes
  pairing_token?: string;
  authed: boolean;
  /** Wall-clock deadline (ms since epoch) by which an UNAUTHENTICATED phone
   *  socket must send pair_offer or be force-closed. Stops attackers from
   *  pinning sockets to the unauth bucket and DoSing real pair attempts. */
  unauth_deadline_ms?: number;
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
    // X-Daemon-Enc-Pubkey: daemon's X25519 encryption pubkey. Required for
    // phones to derive a working shared secret in pair_offer — without this
    // they'd ECDH against the signing key (different curve) and get garbage.
    const enc_pubkey_b64 = req.headers.get("X-Daemon-Enc-Pubkey") ?? undefined;
    const daemon_id = this.state.id.name ?? await deriveDaemonId(pubkey);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const challenge = generateChallenge();
    const att: DaemonAttachment = {
      role: "daemon", pubkey_b64, enc_pubkey_b64,
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
    const url = new URL(req.url);
    const pairing_token = req.headers.get("X-Pairing-Token") ?? url.searchParams.get("token");
    const phone_pubkey_hdr = req.headers.get("X-Phone-Pubkey") ?? url.searchParams.get("phone_pubkey");
    const sig_hdr = req.headers.get("X-Sig") ?? url.searchParams.get("sig");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    if (!pairing_token && !phone_pubkey_hdr) {
      server.close(4000, "missing_pairing_token_or_phone_pubkey");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Cap concurrent UNAUTHENTICATED phone sockets per DO. A malicious actor
    // could otherwise hold open many `pair`-tagged sockets without ever
    // sending pair_offer, exhausting the DO's WebSocket cap and DoSing pair
    // attempts. Authenticated sockets (reconnect-mode after sig verify) are
    // not counted; the limit is solely on the unauthenticated bootstrap window.
    const MAX_UNAUTH_PHONE_SOCKETS = 16;
    const existing = this.state.getWebSockets("phone").filter((ws) => {
      const a = ws.deserializeAttachment() as Attachment | undefined;
      return a && a.role === "phone" && !a.authed;
    });
    if (existing.length >= MAX_UNAUTH_PHONE_SOCKETS) {
      server.close(4029, "too_many_unauth_phone_sockets");
      return new Response(null, { status: 101, webSocket: client });
    }

    if (pairing_token) {
      const phone_id = pairing_token;
      const att: PhoneAttachment = { role: "phone", phone_id, pairing_token, authed: false };
      this.state.acceptWebSocket(server, ["phone", phone_id]);
      server.serializeAttachment(att);
      // Arm a server-side disconnect for sockets that don't send pair_offer
      // within 10s. Without this an attacker (or buggy client) can keep
      // hibernating sockets pinned to the unauthenticated bucket indefinitely.
      // We use storage.setAlarm indirectly through a one-shot setTimeout via
      // alarm doesn't work for per-socket; instead we encode a deadline in
      // the attachment and check on every message + during alarm sweeps.
      att.unauth_deadline_ms = Date.now() + 10_000;
      server.serializeAttachment(att);

      // Prefer the X25519 encryption pubkey (post-fix daemons). Older daemons
      // only stored the signing pubkey — phones paired against those have
      // broken shared secrets and must re-pair after the daemon upgrades.
      const daemonEncPubkey = await this.state.storage.get<string>("daemon_enc_pubkey_b64");
      const daemonPubkey = daemonEncPubkey ?? await this.state.storage.get<string>("daemon_pubkey_b64");
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
      // Tightened from 2-minute (now+prev) to 1-minute window. The previous
      // window made captured sigs (from URL history / TLS-inspection
      // middleboxes / extensions reading query strings) replayable for ~2
      // minutes from any source IP. Phones with mildly-skewed clocks may
      // briefly fail to reconnect — they'll retry next minute, harmless.
      const nowMinute = Math.floor(Date.now() / 60_000);
      const msg = new Uint8Array(daemonIdBytes.length + 8);
      msg.set(daemonIdBytes, 0);
      new DataView(msg.buffer, daemonIdBytes.length, 8).setBigUint64(0, BigInt(nowMinute), false);
      return nacl.sign.detached.verify(msg, sig, pubkey);
    } catch {
      return false;
    }
  }

  // ── Hibernating WebSocket handlers ────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | undefined;
    if (!att) { ws.close(1011, "no_attachment"); return; }

    // Enforce unauth-phone deadline: if this socket is still unauthenticated
    // past its arrival-by deadline, it's been squatting — close it. Cheap
    // check on every message; pair_offer typically arrives in <100ms.
    if (att.role === "phone" && !att.authed && att.unauth_deadline_ms && Date.now() > att.unauth_deadline_ms) {
      ws.close(4029, "unauth_socket_timeout");
      return;
    }

    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: any;
    try { msg = JSON.parse(text); } catch { ws.close(1008, "bad_json"); return; }

    if (att.role === "daemon") return this.handleDaemonMessage(ws, att, msg);
    return this.handlePhoneMessage(ws, att, msg);
  }

  private async handleDaemonMessage(ws: WebSocket, att: DaemonAttachment, msg: any): Promise<void> {
    // App-level keepalive — defeats the 100s idle-WS timeout on CF's edge.
    // Daemon (and optionally phones) send these every 50s; we acknowledge by
    // doing nothing. The cost is one billable request per keepalive, which
    // is the whole point: the DO has to wake to receive it.
    if (msg?.type === "keepalive") return;
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
      // Store the X25519 encryption pubkey separately so pair_init returns the
      // right key for phone-side ECDH. Older daemons that don't send the
      // header → field stays undefined and we fall back in acceptPhone.
      if (att.enc_pubkey_b64) {
        await this.state.storage.put("daemon_enc_pubkey_b64", att.enc_pubkey_b64);
      }
      ws.send(JSON.stringify({ type: "ready", daemon_id: att.daemon_id }));
      return;
    }

    if (msg.type === "register_pairing") {
      const token = String(msg.token ?? "");
      // `persistent: true` makes the token survive both TTL sweeps and claims,
      // so the QR can be permanent until the user rotates. DO storage gets the
      // same flag for its own consistency check in acceptPhone().
      const persistent = msg.persistent === true;
      const expires_at_ms = persistent ? Number.MAX_SAFE_INTEGER : Date.now() + 10 * 60 * 1000;
      await this.state.storage.put("pending_pair", { token, expires_at_ms, persistent });
      if (this.env.PAIRING) {
        const coordId = this.env.PAIRING.idFromName("coordinator");
        const coordStub = this.env.PAIRING.get(coordId);
        await coordStub.fetch("https://x/register", {
          method: "POST",
          body: JSON.stringify({ token, daemon_id: att.daemon_id, persistent }),
          headers: { "content-type": "application/json" },
        });
      }
      return;
    }

    if (msg.type === "pair_ack") {
      for (const phone of this.state.getWebSockets("phone")) {
        const p = phone.deserializeAttachment() as PhoneAttachment;
        if (p && p.pairing_token) {
          // Forward the WHOLE message so daemon_id flows through to phone.
          phone.send(JSON.stringify(msg));
          p.authed = true;
          p.pairing_token = undefined;
          phone.serializeAttachment(p);
        }
      }
      // Persistent tokens are kept — same QR can pair the next device.
      // Ephemeral tokens are consumed once.
      const pending = await this.state.storage.get<{ token: string; expires_at_ms: number; persistent?: boolean }>("pending_pair");
      if (!pending?.persistent) {
        await this.state.storage.delete("pending_pair");
      }
      return;
    }

    if (msg.type === "revoke_phone") {
      // Daemon kicks a previously-paired phone: drop from paired_phones map and
      // close any live WS for that phone.
      const signPk = String(msg.phone_pubkey_b64 ?? "");
      if (signPk) {
        const paired = (await this.state.storage.get<Record<string, string>>("paired_phones")) ?? {};
        if (paired[signPk]) {
          delete paired[signPk];
          await this.state.storage.put("paired_phones", paired);
        }
        for (const ph of this.state.getWebSockets("phone")) {
          const p = ph.deserializeAttachment() as PhoneAttachment | undefined;
          if (p && p.phone_id === signPk) {
            try { ph.send(JSON.stringify({ type: "phone_revoked", by: "daemon" })); } catch { /* */ }
            try { ph.close(4003, "revoked"); } catch { /* */ }
          }
        }
      }
      return;
    }

    // Envelope or other daemon-originated message. Route by `to` field if it
    // identifies a specific phone; otherwise broadcast to all authed phones.
    //   to: "phone:<peer_id>"  → only the matching phone (avoids decryption noise
    //                            on other paired phones that share this DO)
    //   to: anything else / absent → broadcast (back-compat for unaddressed sends)
    const target = typeof msg?.to === "string" ? msg.to : "";
    const peerMatch = /^phone:(.+)$/.exec(target);
    if (peerMatch) {
      const targetPeerId = peerMatch[1];
      for (const phone of this.state.getWebSockets("phone")) {
        const p = phone.deserializeAttachment() as PhoneAttachment;
        if (p && p.authed && p.peer_id === targetPeerId) {
          phone.send(JSON.stringify(msg));
        }
      }
      return;
    }
    for (const phone of this.state.getWebSockets("phone")) {
      const p = phone.deserializeAttachment() as PhoneAttachment;
      if (p && p.authed) phone.send(JSON.stringify(msg));
    }
  }

  private async handlePhoneMessage(ws: WebSocket, att: PhoneAttachment, msg: any): Promise<void> {
    // App-level keepalive (mirror of daemon side); see handleDaemonMessage.
    if (msg?.type === "keepalive") return;
    if (!att.authed) {
      if (msg.type === "pair_offer" && att.pairing_token) {
        const signPk = String(msg.phone_sign_pubkey ?? msg.phone_pubkey ?? "");
        if (signPk) {
          const paired = (await this.state.storage.get<Record<string, string>>("paired_phones")) ?? {};
          paired[signPk] = String(Date.now());
          await this.state.storage.put("paired_phones", paired);
          // Re-key attachment to the signing pubkey so a later revoke_self on
          // this same socket can identify itself without a disconnect+reconnect.
          att.phone_id = signPk;
          ws.serializeAttachment(att);
        }
        this.broadcastToDaemons(msg);
        return;
      }
      ws.close(1008, "expected_pair_offer");
      return;
    }

    if (msg.type === "register_peer_id") {
      // Phone tells the relay its addressable peer_id so daemon→phone envelopes
      // addressed `to: "phone:<peer_id>"` can be routed precisely instead of
      // broadcast-and-discard-noise on every other paired phone.
      const peer_id = String(msg.peer_id ?? "");
      if (peer_id) {
        att.peer_id = peer_id;
        ws.serializeAttachment(att);
      }
      return;
    }

    if (msg.type === "revoke_self") {
      // Phone wants to unpair. att.phone_id IS the signing pubkey in reconnect mode.
      const signPk = att.phone_id;
      if (signPk) {
        const paired = (await this.state.storage.get<Record<string, string>>("paired_phones")) ?? {};
        if (paired[signPk]) {
          delete paired[signPk];
          await this.state.storage.put("paired_phones", paired);
        }
        // Tell daemon to clean up its local config too.
        this.broadcastToDaemons({ type: "phone_revoked", phone_pubkey_b64: signPk });
      }
      try { ws.send(JSON.stringify({ type: "revoked_ok" })); } catch { /* */ }
      ws.close(1000, "revoked");
      return;
    }

    this.broadcastToDaemons(msg);
  }

  /** Multiple daemon WSes can accumulate (e.g. pair CLI restarts before the prior WS is GC'd).
   *  Broadcast to all — only the live process replies. Dead sockets either no-op or get cleaned up
   *  in webSocketClose. */
  /** Broadcast to every daemon WS in the tag. Stale sockets from crashed CLI
   *  sessions can accumulate; sending to a dead one throws and is ignored. The
   *  live daemon(s) — typically one — receive and respond. */
  private broadcastToDaemons(msg: any): void {
    const payload = JSON.stringify(msg);
    for (const d of this.state.getWebSockets("daemon")) {
      try { d.send(payload); } catch { /* dead socket; CF GCs on close */ }
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}
  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}

  private daemonWs(): WebSocket | null {
    const arr = this.state.getWebSockets("daemon");
    return arr[0] ?? null;
  }
}
