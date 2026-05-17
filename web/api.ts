// web/api.ts — single API surface for dashboard fetch + WebSocket calls.
//
// UI components import `apiFetch` and `apiWebSocket` exclusively. The bootstrap
// (web/main.tsx) decides at runtime which Transport implementation to install:
//   - LocalHttpTransport  — built for 127.0.0.1:8765, calls native fetch/WebSocket
//   - TunnelTransport     — built for remote (phone / second laptop), routes
//                           every call through the encrypted CF Worker relay
//
// Adding a new transport (WebRTC P2P, LAN discovery, etc.) means dropping a new
// impl of this interface — no UI change required.

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  // Both styles supported, matching the native WebSocket API surface that
  // web/app.tsx uses today (ws.onopen = ...) and future addEventListener.
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  addEventListener<K extends "open" | "message" | "close" | "error">(
    type: K,
    listener: (ev: any) => void,
  ): void;
  removeEventListener?<K extends "open" | "message" | "close" | "error">(
    type: K,
    listener: (ev: any) => void,
  ): void;
}

export interface Transport {
  readonly mode: "local" | "tunnel";
  fetch(input: string, init?: RequestInit): Promise<Response>;
  openWebSocket(path: string): WebSocketLike;
}

let active: Transport | null = null;

export function setTransport(t: Transport): void {
  active = t;
}

export function getTransport(): Transport {
  if (!active) {
    throw new Error("api.ts: no Transport installed — call setTransport() in your bootstrap before mounting the app");
  }
  return active;
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return getTransport().fetch(input, init);
}

export function apiWebSocket(path: string): WebSocketLike {
  return getTransport().openWebSocket(path);
}
