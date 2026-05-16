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
  role: "user" | "assistant";
  text: string;                  // free-form markdown content
  tool_use?: ToolUseInfo;
  tool_result?: ToolResultInfo;
  raw_type?: string;
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
  last_user_text: string | null;
  last_tool_use: { name: string; description?: string } | null;
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
  let last_user_text: string | null = null;
  let last_tool_use: { name: string; description?: string } | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }

    // ai-title is a special non-message entry
    if (!ai_title && e.type === "ai-title" && typeof e.aiTitle === "string") {
      ai_title = e.aiTitle;
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
        }
      }
    }
    textPart = textPart.trim();

    if (textPart) {
      // Also skip known placeholder strings just in case
      if (textPart === "No response requested." || textPart === "(no content)") continue;

      if (msg.role === "assistant" && !last_assistant_text) {
        last_assistant_text = textPart;
      }
      if (msg.role === "user" && !last_user_text) {
        // skip tool_result-only messages (no text block)
        last_user_text = textPart;
      }
    }

    if (ai_title && last_assistant_text && last_user_text && last_tool_use) break;
  }

  return {
    session_uuid: sessionUuid,
    ai_title,
    last_assistant_text,
    last_user_text,
    last_tool_use,
    last_modified_ms: stat.mtimeMs,
    transcript_path: transcriptPath,
  };
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
    const msg = entry.message;
    if (!msg) continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    // Skip synthetic placeholder messages
    if (msg.model === "<synthetic>") continue;

    const content = msg.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (!trimmed) continue;
      if (trimmed === "No response requested." || trimmed === "(no content)") continue;
      turns.push({ ts, role, text: content, raw_type: entry.type });
      continue;
    }
    if (!Array.isArray(content)) continue;

    // For multi-block messages: emit ONE turn per "interesting block" so the
    // dashboard can render text vs tool_use vs tool_result distinctly.
    // (Most messages have a single block anyway.)
    let added = false;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        turns.push({ ts, role, text: block.text, raw_type: entry.type });
        added = true;
      } else if (block.type === "tool_use") {
        const name = block.name ?? "?";
        const input = block.input ?? {};
        const desc = typeof (input as any)?.description === "string"
          ? (input as any).description
          : undefined;
        turns.push({
          ts, role, text: "", raw_type: entry.type,
          tool_use: {
            id: block.id ?? "",
            name,
            description: desc,
            input,
            input_summary: summarizeToolInput(name, input),
          },
        });
        added = true;
      } else if (block.type === "tool_result") {
        const full = stringifyResult(block.content);
        const truncated = full.length > MAX_TOOL_RESULT_BYTES;
        turns.push({
          ts, role, text: "", raw_type: entry.type,
          tool_result: {
            tool_use_id: block.tool_use_id,
            content: truncated ? full.slice(0, MAX_TOOL_RESULT_BYTES) + "\n…[truncated]" : full,
            truncated,
            is_error: block.is_error === true,
          },
        });
        added = true;
      }
      if (turns.length >= limit) break;
    }
    // (no else — we already added at least one turn or skipped)
    void added;
  }

  return turns.reverse();
}
