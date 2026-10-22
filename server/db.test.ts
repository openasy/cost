import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cost-")), "nested", "cost.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();

    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("keeps one line per day, account, service and so on", () => {
    const db = openDb(":memory:");
    const insert = () => db.prepare("INSERT INTO records (date, provider, account, service, currency, micros) VALUES ('2026-10-01', 'aws', '1', 'S3', 'USD', 5)").run();
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  it("refuses a rate or budget of zero", () => {
    const db = openDb(":memory:");
    expect(() => db.prepare("INSERT INTO rates VALUES ('EUR', 0)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO budgets VALUES ('b', 'x', 'team', NULL, 'pay', 0, 'now')").run()).toThrow();
  });
});
