import type { WebSocket } from "ws";
import { normalizePath } from "./protocol-ext.js";

export interface ExtInfo {
  workspace_root: string;   // will be re-normalized inside add() — caller can pass raw
  version: string;
  registered_at: number;
}

interface InternalEntry {
  ws: WebSocket | any;      // `any` to keep tests trivially mockable
  info: ExtInfo;            // info.workspace_root is normalized
}

export class ExtRegistry {
  private entries: InternalEntry[] = [];

  add(ws: WebSocket | any, info: ExtInfo): void {
    const normalized: ExtInfo = { ...info, workspace_root: normalizePath(info.workspace_root) };
    // Replace existing entry for same ws (defensive — re-register on reconnect)
    this.entries = this.entries.filter((e) => e.ws !== ws);
    this.entries.push({ ws, info: normalized });
  }

  remove(ws: WebSocket | any): void {
    this.entries = this.entries.filter((e) => e.ws !== ws);
  }

  findForCwd(cwd: string): WebSocket | null {
    const target = normalizePath(cwd);
    const matches = this.entries
      .filter((e) => isAncestor(e.info.workspace_root, target))
      .sort((a, b) => b.info.workspace_root.length - a.info.workspace_root.length);
    return matches[0]?.ws ?? null;
  }

  list(): Array<{ info: ExtInfo }> {
    return this.entries.map((e) => ({ info: e.info }));
  }
}

// True when `cwd` equals `root` OR is a path-descendant of it.
// Critically guards against false prefix matches: "d:/codex" must NOT match "d:/code".
function isAncestor(root: string, cwd: string): boolean {
  if (root === cwd) return true;
  return cwd.startsWith(root + "/");
}
