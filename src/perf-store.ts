import Database from "better-sqlite3";

export interface PerfMetricRow {
  session_uuid: string;
  ts: number;         // unix ms
  ttft_ms: number | null;
  tps: number | null; // chars/sec
  char_count: number;
  duration_ms: number;
}

export interface FleetAvg {
  avg_ttft: number | null;
  avg_tps: number | null;
}

export class PerfStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS perf_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uuid TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ttft_ms INTEGER,
        tps REAL,
        char_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_perf_ts ON perf_metrics(ts);
    `);
  }

  insert(row: PerfMetricRow): void {
    this.db.prepare(`
      INSERT INTO perf_metrics (session_uuid, ts, ttft_ms, tps, char_count, duration_ms)
      VALUES (@session_uuid, @ts, @ttft_ms, @tps, @char_count, @duration_ms)
    `).run(row);
  }

  query(fromTs: number, toTs: number): PerfMetricRow[] {
    return this.db.prepare(
      "SELECT session_uuid, ts, ttft_ms, tps, char_count, duration_ms FROM perf_metrics WHERE ts >= ? AND ts <= ? ORDER BY ts ASC"
    ).all(fromTs, toTs) as PerfMetricRow[];
  }

  fleetAvg(fromTs: number, toTs: number): FleetAvg {
    const row = this.db.prepare(`
      SELECT AVG(ttft_ms) AS avg_ttft, AVG(tps) AS avg_tps
      FROM perf_metrics WHERE ts >= ? AND ts <= ? AND ttft_ms IS NOT NULL AND tps IS NOT NULL
    `).get(fromTs, toTs) as { avg_ttft: number | null; avg_tps: number | null };
    return { avg_ttft: row.avg_ttft ?? null, avg_tps: row.avg_tps ?? null };
  }

  deleteOlderThan(beforeTs: number): number {
    const r = this.db.prepare("DELETE FROM perf_metrics WHERE ts < ?").run(beforeTs);
    return r.changes;
  }

  close(): void { this.db.close(); }
}
