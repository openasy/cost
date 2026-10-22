import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convert } from "../tools/ce-to-records.mjs";
import { parseRecords } from "./records.ts";

const answer = {
  GroupDefinitions: [
    { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
    { Type: "DIMENSION", Key: "SERVICE" },
    { Type: "TAG", Key: "Team" },
  ],
  ResultsByTime: [
    {
      TimePeriod: { Start: "2026-10-01", End: "2026-10-02" },
      Groups: [
        { Keys: ["111111111111", "Amazon Elastic Compute Cloud - Compute", "Team$payments"], Metrics: { UnblendedCost: { Amount: "12.3456789", Unit: "USD" } } },
        { Keys: ["111111111111", "Amazon Simple Storage Service", "Team$"], Metrics: { UnblendedCost: { Amount: "0.1", Unit: "USD" } } },
      ],
    },
    { TimePeriod: { Start: "2026-10-02", End: "2026-10-03" }, Groups: [{ Keys: ["222222222222", "AWS Lambda", "Team$"], Metrics: { UnblendedCost: { Amount: "3", Unit: "EUR" } } }] },
  ],
};

describe("ce-to-records", () => {
  it("turns Cost Explorer groups into spend lines, with the tag only when the resource has it", () => {
    const records = convert(answer);
    expect(records).toEqual([
      { date: "2026-10-01", provider: "aws", account: "111111111111", service: "Amazon Elastic Compute Cloud - Compute", amount: 12.3456789, currency: "USD", tags: { team: "payments" } },
      { date: "2026-10-01", provider: "aws", account: "111111111111", service: "Amazon Simple Storage Service", amount: 0.1, currency: "USD", tags: {} },
      { date: "2026-10-02", provider: "aws", account: "222222222222", service: "AWS Lambda", amount: 3, currency: "EUR", tags: {} },
    ]);
  });

  it("makes lines Cost accepts, with the same total", () => {
    const parsed = parseRecords(JSON.stringify(convert(answer)), "application/json");
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ micros: 12_345_679, tags: { team: "payments" } });
  });

  it("keeps region and usage type when the answer is grouped by them, and takes a named metric", () => {
    const ce = {
      GroupDefinitions: [{ Type: "DIMENSION", Key: "LINKED_ACCOUNT" }, { Type: "DIMENSION", Key: "SERVICE" }, { Type: "DIMENSION", Key: "REGION" }, { Type: "DIMENSION", Key: "USAGE_TYPE" }],
      ResultsByTime: [{ TimePeriod: { Start: "2026-10-01", End: "2026-10-02" }, Groups: [{ Keys: ["1", "S3", "eu-west-1", "TimedStorage"], Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" }, BlendedCost: { Amount: "2", Unit: "USD" } } }] }],
    };
    expect(convert(ce)[0]).toMatchObject({ region: "eu-west-1", usageType: "TimedStorage", amount: 1 });
    expect(convert(ce, { metric: "BlendedCost" })[0]!.amount).toBe(2);
    expect(() => convert(ce, { metric: "AmortizedCost" })).toThrow(/AmortizedCost is not in the answer/);
  });

  it("says what is missing instead of sending wrong spend", () => {
    expect(() => convert({})).toThrow(/ResultsByTime/);
    const grouped = (defs: unknown[], keys: string[]) => ({ GroupDefinitions: defs, ResultsByTime: [{ TimePeriod: { Start: "2026-10-01", End: "2026-10-02" }, Groups: [{ Keys: keys, Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } } }] }] });
    expect(() => convert(grouped([{ Type: "DIMENSION", Key: "SERVICE" }], ["S3"]))).toThrow(/LINKED_ACCOUNT/);
    expect(convert(grouped([{ Type: "DIMENSION", Key: "SERVICE" }], ["S3"]), { account: "123" })[0]!.account).toBe("123");
    expect(() => convert(grouped([{ Type: "DIMENSION", Key: "LINKED_ACCOUNT" }], ["1"]))).toThrow(/SERVICE/);
    const monthly = grouped([{ Type: "DIMENSION", Key: "LINKED_ACCOUNT" }, { Type: "DIMENSION", Key: "SERVICE" }], ["1", "S3"]);
    monthly.ResultsByTime[0]!.TimePeriod.End = "2026-11-01";
    expect(() => convert(monthly)).toThrow(/GRANULARITY DAILY|granularity DAILY/i);
  });

  it("works as a command: JSON or NDJSON out, and a clear error with a failing status", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-"));
    const file = join(dir, "ce.json");
    writeFileSync(file, JSON.stringify(answer));
    const script = new URL("../tools/ce-to-records.mjs", import.meta.url).pathname;
    expect(JSON.parse(execFileSync("node", [script, file], { encoding: "utf8" }))).toHaveLength(3);
    expect(execFileSync("node", [script, file, "--ndjson"], { encoding: "utf8" }).trim().split("\n")).toHaveLength(3);
    writeFileSync(file, "{}");
    const failed = spawnSync("node", [script, file], { encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("ResultsByTime");
  });
});
