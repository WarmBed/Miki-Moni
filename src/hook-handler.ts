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

    // session_uuid is the primary identity. Hooks should always provide it
    // (Claude Code sends session_id in every hook event per the official docs).
    // If absent, try resolver as a last resort; otherwise drop the event silently.
    let sessionUuid = ev.session_uuid;
    if (!sessionUuid) {
      sessionUuid = await this.resolver.resolveLatest(cwd);
      if (!sessionUuid) return;  // cannot insert without a primary key
    }

    const existing = this.store.get(sessionUuid);
    if (existing && existing.last_event_at > ev.timestamp) return;  // last-write-wins

    // cwd is IMMUTABLE once the row exists. Claude Code's projects-dir
    // encoding is derived from the cwd-at-session-start; the SDK's
    // `resume: uuid` only works if you pass that same cwd. If we let later
    // hook events overwrite (e.g. the agent cd'd into a subfolder, or a
    // tool runs in a different working dir), /wrap/start later uses the
    // wrong cwd → SDK throws "No conversation found with session ID".
    // The very first event for a uuid sets cwd; every subsequent event
    // keeps it. Bug repro: agent cd'd from d:\code into d:\code\cc-hub →
    // hook events flipped DB.cwd → wrap-spawn looked in d--code-cc-hub/
    // for a transcript that actually lived in d--code/.
    const cwdToStore = existing?.cwd ?? cwd;
    const next: Session = {
      // TODO(Phase 2.3): replace with existing?.agent ?? ev.agent
      agent: "claude",
      cwd: cwdToStore,
      session_uuid: sessionUuid,
      project_name: existing?.project_name ?? basename(cwdToStore),
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
  }
}
