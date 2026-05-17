// TunnelTransport — HTTP + WebSocket requests routed through the encrypted CF
// Worker relay. Used when the dashboard is loaded from a remote origin
// (miki-phone.pages.dev, second laptop, tablet, etc.).
//
// Inside every encrypted envelope sent to the daemon, the inner JSON has a
// `kind` field. Two families of inner messages:
//
//   HTTP (request/response, single round trip):
//     phone  → daemon   { kind:"http_proxy",          request_id, method, path, headers?, body? }
//     daemon → phone    { kind:"http_proxy_response", request_id, status, headers, body }
//
//   WS proxy (long-lived; one local WS per tunnel_ws_id):
//     phone  → daemon   { kind:"ws_proxy_open",  tunnel_ws_id, path }
//     daemon → phone    { kind:"ws_proxy_opened",tunnel_ws_id }
//     daemon → phone    { kind:"ws_proxy_msg",   tunnel_ws_id, data }
//     phone  → daemon   { kind:"ws_proxy_send",  tunnel_ws_id, data }
//     either            { kind:"ws_proxy_close", tunnel_ws_id, code?, reason? }
//
// `request_id` and `tunnel_ws_id` are UUIDs minted by the phone.

import { encodeEnvelope, decodeEnvelope, type Envelope } from "../web-phone/relay";
import type { Transport, WebSocketLike } from "./api";

const REQ_TIMEOUT_MS = 30_000;

type PendingHttp = {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

interface InboundDispatcher {
  onHttpResponse(request_id: string, status: number, headers: Record<string, string>, body: string): void;
  onWsOpened(tunnel_ws_id: string): void;
  onWsMsg(tunnel_ws_id: string, data: string): void;
  onWsClose(tunnel_ws_id: string, code: number, reason: string): void;
}

export interface TunnelTransportDeps {
  /** Live relay WebSocket — caller (bootstrap) is responsible for reconnect logic
   *  and re-installing this dep if the underlying socket is replaced. */
  ws: WebSocket;
  /** Shared secret with the daemon (32 bytes). */
  sharedSecret: Uint8Array;
}

export class TunnelTransport implements Transport {
  readonly mode = "tunnel" as const;
  private pendingHttp = new Map<string, PendingHttp>();
  private wsShims = new Map<string, ProxiedWebSocket>();

  constructor(private deps: TunnelTransportDeps) {
    deps.ws.addEventListener("message", (ev: MessageEvent) => this.onRelayMessage(ev));
  }

  private send(plain: object): void {
    const env = encodeEnvelope(plain, this.deps.sharedSecret, "daemon");
    this.deps.ws.send(JSON.stringify(env));
  }

  private onRelayMessage(ev: MessageEvent): void {
    let env: Envelope;
    try { env = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
    catch { return; }
    // Control-plane messages from the relay itself (no envelope shape) are
    // handled elsewhere (e.g. {type:"revoked_ok"}); skip if not enveloped.
    if (!env || typeof env.ct !== "string" || typeof env.nonce !== "string") return;
    const plain = decodeEnvelope(env, this.deps.sharedSecret) as
      | { kind?: string; [k: string]: unknown }
      | null;
    if (!plain || typeof plain.kind !== "string") return;
    this.dispatch(plain as any);
  }

  private dispatch(msg: any): void {
    switch (msg.kind) {
      case "http_proxy_response": {
        const id = String(msg.request_id ?? "");
        const pending = this.pendingHttp.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingHttp.delete(id);
        const status: number = typeof msg.status === "number" ? msg.status : 0;
        const headers: Record<string, string> = (msg.headers && typeof msg.headers === "object")
          ? (msg.headers as Record<string, string>) : {};
        const body: string = typeof msg.body === "string" ? msg.body : "";
        pending.resolve(buildResponse(status, headers, body));
        return;
      }
      case "ws_proxy_opened": {
        const shim = this.wsShims.get(String(msg.tunnel_ws_id ?? ""));
        shim?._handleOpen();
        return;
      }
      case "ws_proxy_msg": {
        const shim = this.wsShims.get(String(msg.tunnel_ws_id ?? ""));
        shim?._handleMessage(String(msg.data ?? ""));
        return;
      }
      case "ws_proxy_close": {
        const id = String(msg.tunnel_ws_id ?? "");
        const shim = this.wsShims.get(id);
        if (shim) {
          shim._handleClose(
            typeof msg.code === "number" ? msg.code : 1000,
            typeof msg.reason === "string" ? msg.reason : "",
          );
          this.wsShims.delete(id);
        }
        return;
      }
    }
  }

  fetch(input: string, init?: RequestInit): Promise<Response> {
    const request_id = newId();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersToRecord(init?.headers);
    const body = init?.body == null ? undefined :
      typeof init.body === "string" ? init.body :
      JSON.stringify(init.body); // best-effort for non-string bodies (form data not supported in v1)

    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHttp.delete(request_id);
        reject(new TunnelTimeoutError(`tunnel fetch timeout: ${method} ${input}`));
      }, REQ_TIMEOUT_MS);
      this.pendingHttp.set(request_id, { resolve, reject, timer });
      this.send({
        kind: "http_proxy", request_id, method, path: input,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    });
  }

  openWebSocket(path: string): WebSocketLike {
    const id = newId();
    const shim = new ProxiedWebSocket(id, path, (kind, extra) => this.send({ kind, tunnel_ws_id: id, ...extra }));
    this.wsShims.set(id, shim);
    this.send({ kind: "ws_proxy_open", tunnel_ws_id: id, path });
    return shim;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function newId(): string {
  // crypto.randomUUID is available in modern browsers + workerd
  return (globalThis.crypto as Crypto).randomUUID();
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
}

function buildResponse(status: number, headers: Record<string, string>, body: string): Response {
  return new Response(body, { status, headers });
}

export class TunnelTimeoutError extends Error {
  constructor(msg: string) { super(msg); this.name = "TunnelTimeoutError"; }
}

// ── Proxied WebSocket (client-side shim) ─────────────────────────────────────

const READY_CONNECTING = 0, READY_OPEN = 1, READY_CLOSING = 2, READY_CLOSED = 3;

type SendFn = (kind: "ws_proxy_send" | "ws_proxy_close", extra: Record<string, unknown>) => void;

class ProxiedWebSocket implements WebSocketLike {
  readyState: number = READY_CONNECTING;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  private listeners: Record<string, ((ev: any) => void)[]> = {};

  constructor(
    private id: string,
    public readonly path: string,
    private sendOut: SendFn,
  ) {}

  addEventListener(type: string, cb: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: (ev: any) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== cb);
  }

  private fire(type: "open" | "message" | "close" | "error", ev: any): void {
    const propHandler = (this as any)["on" + type] as ((ev: any) => void) | null;
    if (propHandler) {
      try { propHandler(ev); } catch { /* ignore */ }
    }
    for (const cb of this.listeners[type] ?? []) {
      try { cb(ev); } catch { /* ignore listener throw */ }
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== READY_OPEN) throw new Error("WebSocket is not open");
    const str = typeof data === "string" ? data : "[binary not supported in v1 tunnel]";
    this.sendOut("ws_proxy_send", { data: str });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === READY_CLOSED) return;
    this.readyState = READY_CLOSING;
    this.sendOut("ws_proxy_close", { code, reason });
    // Optimistically transition; daemon will confirm via ws_proxy_close back.
    this._handleClose(code, reason);
  }

  // ── Methods invoked by TunnelTransport.dispatch ──
  _handleOpen(): void {
    this.readyState = READY_OPEN;
    this.fire("open", { type: "open" });
  }

  _handleMessage(data: string): void {
    this.fire("message", { type: "message", data });
  }

  _handleClose(code: number, reason: string): void {
    this.readyState = READY_CLOSED;
    this.fire("close", { type: "close", code, reason, wasClean: code === 1000 });
  }
}
