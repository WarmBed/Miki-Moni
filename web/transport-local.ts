// LocalHttpTransport — same-origin fetch + native WebSocket.
// Used when the dashboard is loaded from http://127.0.0.1:8765 directly.

import type { Transport, WebSocketLike } from "./api";

export class LocalHttpTransport implements Transport {
  readonly mode = "local" as const;

  fetch(input: string, init?: RequestInit): Promise<Response> {
    return window.fetch(input, init);
  }

  openWebSocket(path: string): WebSocketLike {
    // Same-origin WS — http→ws, https→wss.
    const origin = window.location.origin.replace(/^http/, "ws");
    return new window.WebSocket(origin + path) as unknown as WebSocketLike;
  }
}
