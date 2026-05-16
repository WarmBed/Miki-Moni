import type {
  DaemonMessage, ExtMessage, MsgSubmit, MsgSubmitAck, MsgPong,
} from "./protocol.js";

// Structural shape — extension uses `ws` package's WebSocket at runtime,
// tests substitute a fake. Both satisfy this interface.
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: any) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export interface WsClientOptions {
  url: string;
  registerInfo: () => { workspace_root: string; helper_version: string };
  onSubmit: (req: MsgSubmit) => Promise<MsgSubmitAck>;
  WebSocketCtor: new (url: string) => WsLike;
  // Returns the next reconnect delay in ms given the current attempt count (1-based).
  // Default: exponential backoff 1s, 2s, 4s, 8s, 16s, capped at 30s.
  backoffMs?: (attempt: number) => number;
  log?: (msg: string, ctx?: object) => void;
}

const DEFAULT_BACKOFF = (attempt: number) => Math.min(30_000, 1000 * Math.pow(2, attempt - 1));

export class WsClient {
  private ws: WsLike | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly backoff: (attempt: number) => number;

  constructor(private readonly opts: WsClientOptions) {
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  private connect(): void {
    const ws = new this.opts.WebSocketCtor(this.opts.url);
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      const info = this.opts.registerInfo();
      this.sendMsg({ type: "register", workspace_root: info.workspace_root, helper_version: info.helper_version });
      this.opts.log?.("ws connected, registered", info);
    });
    ws.on("message", (data: any) => {
      this.handleMessage(String(data));
    });
    ws.on("close", () => {
      this.ws = null;
      if (this.stopped) return;
      this.attempt += 1;
      const delay = this.backoff(this.attempt);
      this.opts.log?.("ws closed, reconnecting", { attempt: this.attempt, delay });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    ws.on("error", (err) => {
      this.opts.log?.("ws error", { error: String(err) });
      // Let `close` handler trigger the reconnect; do nothing here.
    });
  }

  private handleMessage(text: string): void {
    let msg: DaemonMessage;
    try { msg = JSON.parse(text); } catch {
      this.opts.log?.("ws got malformed json, ignoring", { text: text.slice(0, 200) });
      return;
    }
    if (msg.type === "submit") {
      this.opts.onSubmit(msg).then((ack) => this.sendMsg(ack));
      return;
    }
    if (msg.type === "ping") {
      const pong: MsgPong = { type: "pong", request_id: msg.request_id };
      this.sendMsg(pong);
      return;
    }
  }

  private sendMsg(msg: ExtMessage): void {
    if (!this.ws) return;
    try { this.ws.send(JSON.stringify(msg)); }
    catch (err) { this.opts.log?.("ws send failed", { error: String(err) }); }
  }
}
