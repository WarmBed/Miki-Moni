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
}
