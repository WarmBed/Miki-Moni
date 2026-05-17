// Wire protocol between miki-moni daemon (WS server at /ws_ext) and
// miki-helper VSCode extension (WS client). One JSON object per WS frame.

// ── Extension → Daemon ─────────────────────────────────────────────────────
export interface MsgRegister {
  type: "register";
  workspace_root: string;   // absolute path, lowercase forward-slash on Windows
  helper_version: string;   // semver from extension's package.json
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

// ── Daemon → Extension ─────────────────────────────────────────────────────
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

// ── Normalization helper ───────────────────────────────────────────────────
// Daemon and extension MUST normalize workspace/cwd paths identically for the
// longest-prefix-wins routing to work. Lower-case, forward-slash, no trailing /.
export function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/").toLowerCase();
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}
