import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- Spend, one row per day and line. Money is an integer in millionths of the currency, so sums are exact (ADR 0051).
   CREATE TABLE records (
     date TEXT NOT NULL,
     provider TEXT NOT NULL,
     account TEXT NOT NULL,
     service TEXT NOT NULL,
     region TEXT NOT NULL DEFAULT '',
     resource TEXT NOT NULL DEFAULT '',
     usage_type TEXT NOT NULL DEFAULT '',
     currency TEXT NOT NULL,
     micros INTEGER NOT NULL,
     tags TEXT NOT NULL DEFAULT '{}',
     team TEXT,
     PRIMARY KEY (date, provider, account, service, region, resource, usage_type, currency)
   ) WITHOUT ROWID;
   CREATE INDEX records_account ON records (account, service, date);
   CREATE INDEX records_team ON records (team, date);
   -- What one unit of a currency is worth in the reporting currency. Kept by an admin; nothing is fetched.
   CREATE TABLE rates (currency TEXT PRIMARY KEY, rate REAL NOT NULL CHECK (rate > 0));
   -- Who owns spend that is not tagged with a team. In order, first match wins.
   CREATE TABLE rules (
     id TEXT PRIMARY KEY,
     position INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('account', 'service', 'tag')),
     match TEXT NOT NULL,
     tag_key TEXT,
     team TEXT NOT NULL
   );
   CREATE TABLE budgets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     scope TEXT NOT NULL CHECK (scope IN ('team', 'tag')),
     tag_key TEXT,
     value TEXT NOT NULL,
     micros INTEGER NOT NULL CHECK (micros > 0),
     created_at TEXT NOT NULL
   );
   -- A day of one service in one account that cost much more than the days before it.
   CREATE TABLE anomalies (
     id TEXT PRIMARY KEY,
     date TEXT NOT NULL,
     account TEXT NOT NULL,
     service TEXT NOT NULL,
     micros INTEGER NOT NULL,
     mean_micros INTEGER NOT NULL,
     sd_micros INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'expected')),
     reason TEXT,
     decided_by TEXT,
     decided_at TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (date, account, service)
   )`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
