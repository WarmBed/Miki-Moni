import path from "node:path";
import type { HookEvent, Session, SessionStatus } from "./types.js";
import type { SessionStore } from "./session-store.js";
import type { SessionResolver } from "./session-resolver.js";
import type { Notifier } from "./notifier.js";

const STATUS_BY_EVENT: Record<HookEvent["event_type"], SessionStatus> = {
  session_start: "active",
  user_prompt: "active",
  pre_tool_use: "active",
  post_tool_use: "active",
  stop: "waiting",
};

function basename(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  return path.posix.basename(normalized);
}

// On Windows, paths like "D:\code\x" and "d:/code/x" point to the same place.
// Normalize: lowercase the drive letter and use backslashes consistently.
export function normalizeCwd(cwd: string): string {
  let n = cwd.replace(/\//g, "\\");
  // Lowercase Windows drive letter (e.g. "D:\..." → "d:\...")
  if (/^[A-Za-z]:/.test(n)) n = n[0]!.toLowerCase() + n.slice(1);
  // Trim trailing backslash unless it's just a drive root like "c:\"
  if (n.length > 3 && n.endsWith("\\")) n = n.replace(/\\+$/, "");
  return n;
}

export class HookHandler {
  constructor(
    private store: SessionStore,
    private resolver: SessionResolver,
    private notifier?: Notifier,
  ) {}

  async handle(ev: HookEvent): Promise<void> {
    const cwd = normalizeCwd(ev.cwd);
    const existing = this.store.get(cwd);
    if (existing && existing.last_event_at > ev.timestamp) return;  // last-write-wins

    const next: Session = {
      cwd,
      session_uuid: ev.session_uuid ?? existing?.session_uuid ?? null,
      project_name: basename(cwd),
      status: STATUS_BY_EVENT[ev.event_type],
      last_event_at: ev.timestamp,
      last_message_preview: existing?.last_message_preview ?? "",
      tokens_in: existing?.tokens_in ?? 0,
      tokens_out: existing?.tokens_out ?? 0,
      vscode_pid: existing?.vscode_pid ?? null,
    };
    this.store.upsert(next);

    const wasWaiting = existing?.status === "waiting";
    const isWaiting = next.status === "waiting";
    if (this.notifier && isWaiting && !wasWaiting) {
      void this.notifier.notify({
        project: next.project_name,
        message: "Claude is waiting for you",
      });
    }

    if (!next.session_uuid) {
      // Fire-and-forget backfill
      void this.backfillUuid(cwd);
    }
  }

  private async backfillUuid(cwd: string): Promise<void> {
    const uuid = await this.resolver.resolveLatest(cwd);
    if (!uuid) return;
    const current = this.store.get(cwd);
    if (!current || current.session_uuid) return;
    this.store.upsert({ ...current, session_uuid: uuid });
  }
}
