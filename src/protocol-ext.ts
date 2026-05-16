// Daemon-side mirror of extension/src/protocol.ts. Kept duplicate (not a
// symlink/shared package) because the extension is a separate npm package
// with its own dist; cross-package import would complicate the VSIX build.
// Drift risk is low — types are small and stable. If they ever diverge, both
// integration test (ws_ext routing) and submitter test will fail.

export interface MsgRegister {
  type: "register";
  workspace_root: string;
  helper_version: string;
}

export interface MsgSubmitAck {
  type: "submit_ack";
  request_id: string;
  ok: boolean;
  error?: string;
  diag?: string;
}

export interface MsgPong {
  type: "pong";
  request_id: string;
}

export type ExtMessage = MsgRegister | MsgSubmitAck | MsgPong;

export interface MsgSubmit {
  type: "submit";
  request_id: string;
  session_uuid: string;
  prompt: string;
}

export interface MsgPing {
  type: "ping";
  request_id: string;
}

export type DaemonMessage = MsgSubmit | MsgPing;

export function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/").toLowerCase();
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}
