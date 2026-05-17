import { promises as fs } from "node:fs";
import path from "node:path";

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[\/\\:]/g, "-");
}

export class SessionResolver {
  constructor(private projectsRoot: string) {}

  async resolveLatest(cwd: string): Promise<string | null> {
    const dir = path.join(this.projectsRoot, encodeCwd(cwd));
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) return null;

    const withMtime = await Promise.all(
      jsonlFiles.map(async (f) => ({
        file: f,
        mtime: (await fs.stat(path.join(dir, f))).mtimeMs,
      }))
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const latest = withMtime[0]!.file;
    return latest.replace(/\.jsonl$/, "");
  }

  /** Scan all project dirs to find which one holds <sessionUuid>.jsonl. */
  async findTranscriptPath(sessionUuid: string): Promise<string | null> {
    let dirs: string[];
    try {
      dirs = await fs.readdir(this.projectsRoot);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const candidate = path.join(this.projectsRoot, d, `${sessionUuid}.jsonl`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch { /* keep looking */ }
    }
    return null;
  }
}

// ── Transcript reading ────────────────────────────────────────────────────

export interface ToolUseInfo {
  id: string;
  name: string;          // "Bash" / "Edit" / "Read" / etc.
  description?: string;  // when tool_input.description exists (e.g. Bash)
  input: unknown;        // raw input JSON
  input_summary: string; // 1-line preview for collapsed view
}

export interface ToolResultInfo {
  tool_use_id?: string;
  content: string;       // truncated to a reasonable size (8 KB)
  truncated: boolean;
  is_error?: boolean;
}

export interface TranscriptTurn {
  ts: string;
  /**
   * "user" / "assistant" = real conversation turns.
   * "system" = harness-injected meta entries (skill content, task-notification,
   * tool-originated user turns). Stored in the JSONL as role:"user" but should
   * NOT be displayed as if the human typed them.
   */
  role: "user" | "assistant" | "system";
  text: string;                  // free-form markdown content
  tool_use?: ToolUseInfo;
  tool_result?: ToolResultInfo;
  raw_type?: string;
}

/**
 * True if a JSONL entry with role:"user" is harness-injected (skill content,
 * task notifications, tool-originated user turns) rather than something the
 * human typed.
 */
function isInjectedUserEntry(e: any): boolean {
  if (!e) return false;
  if (e.isMeta === true) return true;
  if (typeof e.sourceToolUseID === "string") return true;
  if (e.origin && typeof e.origin.kind === "string") return true;
  return false;
}

const MAX_TOOL_RESULT_BYTES = 8 * 1024;

function summarizeToolInput(name: string, input: unknown): string {
  if (input == null || typeof input !== "object") return String(input ?? "");
  const o = input as Record<string, unknown>;
  // Pick a sensible one-line summary by tool
  if (name === "Bash") return String(o.command ?? "").split("\n")[0]?.slice(0, 200) ?? "";
  if (name === "Read") return String(o.file_path ?? "");
  if (name === "Write") return `${o.file_path ?? ""} (${(o.content as string)?.length ?? 0} chars)`;
  if (name === "Edit") return `${o.file_path ?? ""}`;
  if (name === "Glob") return String(o.pattern ?? "");
  if (name === "Grep") return String(o.pattern ?? "");
  if (name === "WebFetch" || name === "WebSearch") return String(o.url ?? o.query ?? "");
  if (name === "TodoWrite") return `${Array.isArray(o.todos) ? o.todos.length : "?"} todos`;
  // Default: short JSON
  return JSON.stringify(o).slice(0, 200);
}

function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c))).join("");
  }
  return JSON.stringify(content ?? "");
}

export interface SessionPreview {
  session_uuid: string;
  ai_title: string | null;
  last_assistant_text: string | null;
  last_assistant_ts: string | null;
  last_user_text: string | null;
  last_user_ts: string | null;
  last_tool_use: { name: string; description?: string } | null;
  last_tool_use_ts: string | null;
  last_modified_ms: number;
  transcript_path: string;
}

/**
 * Cheap-ish scan: read tail of transcript, extract ai_title (special entry),
 * last assistant text block, and last user message (skipping tool_results).
 */
export async function readSessionPreview(
  sessionUuid: string,
  transcriptPath: string,
): Promise<SessionPreview> {
  const stat = await fs.stat(transcriptPath);
  const raw = await fs.readFile(transcriptPath, "utf8");
  // Last ~500 lines is plenty to find recent assistant/user text + ai-title
  const allLines = raw.split(/\r?\n/);
  const lines = allLines.slice(-500);

  let ai_title: string | null = null;
  let last_assistant_text: string | null = null;
  let last_assistant_ts: string | null = null;
  let last_user_text: string | null = null;
  let last_user_ts: string | null = null;
  let last_tool_use: { name: string; description?: string } | null = null;
  let last_tool_use_ts: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }

    const entryTs = typeof e.timestamp === "string" ? e.timestamp : null;

    // ai-title is a special non-message entry
    if (!ai_title && e.type === "ai-title" && typeof e.aiTitle === "string") {
      ai_title = e.aiTitle;
    }

    // Slash commands (type:"system", subtype:"local_command") are NOT message
    // entries but they ARE conversation in the user's eyes. Treat them as
    // last_user_text / last_assistant_text for the card preview.
    if (e.type === "system" && e.subtype === "local_command" && typeof e.content === "string") {
      const raw = e.content;
      const out = raw.match(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/);
      if (out) {
        const text = (out[1] ?? "").trim();
        if (text && !last_assistant_text) { last_assistant_text = `↪ ${text}`; last_assistant_ts = entryTs; }
      } else {
        const text = raw.trim();
        if (text && !last_user_text) { last_user_text = `⚡ ${text}`; last_user_ts = entryTs; }
      }
      if (ai_title && last_assistant_text && last_user_text && last_tool_use) break;
      continue;
    }

    const msg = e.message;
    if (!msg) continue;

    // Skip synthetic placeholder messages Claude Code writes when no model
    // response was needed (e.g. {model:"<synthetic>", text:"No response requested."}).
    if (msg.model === "<synthetic>") continue;

    // Extract text content + scan for most recent tool_use (assistant turns).
    let textPart = "";
    if (typeof msg.content === "string") {
      textPart = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          textPart += block.text;
        } else if (!last_tool_use && block?.type === "tool_use" && typeof block.name === "string") {
          const desc = typeof block.input?.description === "string" ? block.input.description : undefined;
          last_tool_use = { name: block.name, description: desc };
          last_tool_use_ts = entryTs;
        }
      }
    }
    textPart = textPart.trim();

    if (textPart) {
      // Also skip known placeholder strings just in case
      if (textPart === "No response requested." || textPart === "(no content)") continue;

      if (msg.role === "assistant" && !last_assistant_text) {
        last_assistant_text = textPart;
        last_assistant_ts = entryTs;
      }
      if (msg.role === "user" && !last_user_text) {
        // Skip harness-injected user turns (skill content, Skill tool output,
        // task notifications, system reminders). They contain real text blocks
        // so the textPart filter above won't catch them — they'd otherwise
        // shadow the actual most-recent user message in the reverse scan.
        if (!isInjectedUserEntry(e)) {
          last_user_text = textPart;
          last_user_ts = entryTs;
        }
      }
    }

    if (ai_title && last_assistant_text && last_user_text && last_tool_use) break;
  }

  return {
    session_uuid: sessionUuid,
    ai_title,
    last_assistant_text,
    last_assistant_ts,
    last_user_text,
    last_user_ts,
    last_tool_use,
    last_tool_use_ts,
    last_modified_ms: stat.mtimeMs,
    transcript_path: transcriptPath,
  };
}

/**
 * Read the original cwd that the session was started with — what's stored on
 * the very first JSONL entry that carries a `cwd` field. The SDK encodes the
 * projects directory from THIS cwd, so `query({ resume: uuid, cwd })` only
 * works if you pass exactly this value. DB.cwd can drift if hook events fire
 * from subdirectories — never trust DB.cwd for wrap resume.
 *
 * Returns null when the file is missing or no cwd field is found in the
 * first ~50 lines (defensive cap; in practice cwd shows up by line 2-3).
 */
export async function readOriginalCwd(transcriptPath: string): Promise<string | null> {
  let raw: string;
  try { raw = await fs.readFile(transcriptPath, "utf8"); }
  catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const lines = raw.split(/\r?\n/).slice(0, 50);
  for (const line of lines) {
    if (!line || !line.includes('"cwd"')) continue;
    try {
      const e: any = JSON.parse(line);
      if (typeof e.cwd === "string" && e.cwd) return e.cwd;
    } catch { /* skip unparseable */ }
  }
  return null;
}

/**
 * Cheap check: does this session's transcript contain ANY real user/assistant
 * turn? Used by daemon to decide if a wrap-spawned session that closed without
 * activity should be auto-deleted (vs. left as stale).
 *
 * "Real" means: text content from role=user (typed by human) OR role=assistant
 * with non-synthetic content. Tool_result blocks (which appear as role=user)
 * and synthetic placeholders ("No response requested.") are ignored.
 *
 * Returns false if the file doesn't exist (treated as "no turns yet").
 */
export async function sessionHasAnyTurns(transcriptPath: string): Promise<boolean> {
  let raw: string;
  try { raw = await fs.readFile(transcriptPath, "utf8"); }
  catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw e;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    // Real user typing or any non-synthetic assistant output counts.
    const msg = e.message;
    if (!msg) continue;
    if (msg.model === "<synthetic>") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      const t = msg.content.trim();
      if (t && t !== "No response requested." && t !== "(no content)") return true;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      // Text from either role = real turn. tool_use only on assistant side =
      // a real turn (model decided to act). tool_result we deliberately skip
      // (it's just the wrapper's first SDK-init artifact in many cases).
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return true;
      if (block.type === "tool_use" && msg.role === "assistant") return true;
    }
  }
  return false;
}

/** Read last `limit` "interesting" turns from a Claude Code JSONL transcript. */
export async function readTranscriptTail(
  filePath: string,
  limit = 20,
): Promise<TranscriptTurn[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);

  const turns: TranscriptTurn[] = [];
  for (let i = lines.length - 1; i >= 0 && turns.length < limit; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.timestamp ?? "";

    // Slash commands (e.g. /model, /clear) are stored as type:"system" entries:
    //   - subtype:"local_command", content:"/model sonnet4.5"   ← user typed
    //   - subtype:"local_command", content:"<local-command-stdout>...</local-command-stdout>"  ← SDK response
    // They never appear as message.role=user/assistant, so the dashboard
    // dropped them silently. Surface them in the conversation column.
    if (entry.type === "system" && entry.subtype === "local_command" && typeof entry.content === "string") {
      const raw = entry.content;
      const out = raw.match(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/);
      if (out) {
        const text = (out[1] ?? "").trim();
        if (text) turns.push({ ts, role: "assistant", text: `↪ ${text}`, raw_type: "local_command_stdout" });
      } else {
        const text = raw.trim();
        if (text) turns.push({ ts, role: "user", text: `⚡ ${text}`, raw_type: "local_command_input" });
      }
      continue;
    }

    const msg = entry.message;
    if (!msg) continue;
    const rawRole = msg.role;
    if (rawRole !== "user" && rawRole !== "assistant") continue;

    // Skip synthetic placeholder messages
    if (msg.model === "<synthetic>") continue;

    // Harness-injected user-role entries (skill content, task-notification,
    // tool-originated turns) should be surfaced as "system" so the modal
    // doesn't mislabel them as something the human typed. tool_result blocks
    // keep role "user" (they're conceptually the tool's reply lane).
    const injected = rawRole === "user" && isInjectedUserEntry(entry);

    const content = msg.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (!trimmed) continue;
      if (trimmed === "No response requested." || trimmed === "(no content)") continue;
      const role: TranscriptTurn["role"] = injected ? "system" : rawRole;
      turns.push({ ts, role, text: content, raw_type: entry.type });
      continue;
    }
    if (!Array.isArray(content)) continue;

    // For multi-block messages: emit ONE turn per "interesting block" so the
    // dashboard can render text vs tool_use vs tool_result distinctly.
    //
    // BUG NOTE: iterating blocks in FORWARD order while iterating entries
    // BACKWARD then calling `turns.reverse()` at the end inverts the
    // block-within-entry order. e.g. an assistant message with [B1, B2, B3]
    // ended up rendered as [B3, B2, B1] — early text vanished behind a
    // later tool, looking like "only one round shown". Fix: iterate blocks
    // BACKWARD too so the outer reverse() restores correct order.
    for (let bi = content.length - 1; bi >= 0; bi--) {
      const block = content[bi];
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const role: TranscriptTurn["role"] = injected ? "system" : rawRole;
        turns.push({ ts, role, text: block.text, raw_type: entry.type });
      } else if (block.type === "tool_use") {
        const name = block.name ?? "?";
        const input = block.input ?? {};
        const desc = typeof (input as any)?.description === "string"
          ? (input as any).description
          : undefined;
        turns.push({
          ts, role: rawRole, text: "", raw_type: entry.type,
          tool_use: {
            id: block.id ?? "",
            name,
            description: desc,
            input,
            input_summary: summarizeToolInput(name, input),
          },
        });
      } else if (block.type === "tool_result") {
        const full = stringifyResult(block.content);
        const truncated = full.length > MAX_TOOL_RESULT_BYTES;
        turns.push({
          ts, role: rawRole, text: "", raw_type: entry.type,
          tool_result: {
            tool_use_id: block.tool_use_id,
            content: truncated ? full.slice(0, MAX_TOOL_RESULT_BYTES) + "\n…[truncated]" : full,
            truncated,
            is_error: block.is_error === true,
          },
        });
      }
    }
  }

  // We pushed entries newest-first AND blocks-within-entry latest-first.
  // Trim to the requested limit (drops oldest blocks of the oldest visible
  // entry first — desired behavior: keep latest content visible), then
  // reverse for chronological order. The previous in-loop limit check
  // could chop off MID-entry, causing single-message data loss.
  return turns.slice(0, limit).reverse();
}
