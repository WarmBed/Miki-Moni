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

export interface TranscriptTurn {
  ts: string;                            // ISO timestamp from the entry
  role: "user" | "assistant" | "system" | "tool" | "other";
  text: string;                          // human-readable summary
  tool_use?: { name: string; summary: string };
  is_tool_result?: boolean;
  raw_type?: string;                     // original entry type for debugging
}

/** Read last `limit` "interesting" turns from a Claude Code JSONL transcript. */
export async function readTranscriptTail(
  filePath: string,
  limit = 20,
): Promise<TranscriptTurn[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);

  const turns: TranscriptTurn[] = [];
  // Walk from end backwards, collecting up to `limit` user+assistant turns
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

    const turn: TranscriptTurn = { ts, role, text: "", raw_type: entry.type };

    // content can be string or array of blocks
    const content = msg.content;
    if (typeof content === "string") {
      turn.text = content;
    } else if (Array.isArray(content)) {
      // Concat text blocks; if there are tool_use / tool_result, surface them too
      const textParts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          const summary = typeof block.input === "object"
            ? JSON.stringify(block.input).slice(0, 200)
            : String(block.input ?? "");
          turn.tool_use = { name: block.name ?? "?", summary };
          textParts.push(`[tool_use: ${block.name}]`);
        } else if (block.type === "tool_result") {
          turn.is_tool_result = true;
          const t = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => c?.text ?? "").join("")
              : JSON.stringify(block.content ?? "").slice(0, 200);
          textParts.push(`[tool_result] ${t.slice(0, 300)}`);
        }
      }
      turn.text = textParts.join("\n");
    }

    // Skip empty turns
    if (!turn.text.trim() && !turn.tool_use && !turn.is_tool_result) continue;

    turns.push(turn);
  }

  // We walked backwards; reverse to chronological (oldest → newest)
  return turns.reverse();
}
