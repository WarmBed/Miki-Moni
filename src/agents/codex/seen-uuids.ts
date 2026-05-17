import { promises as fs } from "node:fs";

interface Persisted { order: string[]; }

export class SeenUuids {
  constructor(private filePath: string, private capacity: number = 500) {}

  /** Returns true iff uuid was NOT previously seen (i.e., this is the first sight). */
  async recordAndCheck(uuid: string): Promise<boolean> {
    const list = await this.load();
    const idx = list.indexOf(uuid);
    const firstSight = idx === -1;
    if (idx !== -1) list.splice(idx, 1);
    list.push(uuid);
    while (list.length > this.capacity) list.shift();
    await this.save(list);
    return firstSight;
  }

  private async load(): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Persisted;
      return Array.isArray(parsed.order) ? parsed.order : [];
    } catch { return []; }
  }

  private async save(list: string[]): Promise<void> {
    const data: Persisted = { order: list };
    await fs.writeFile(this.filePath, JSON.stringify(data));
  }
}
