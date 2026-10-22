import { describe, expect, it } from "vitest";
import { isDay, parseCsv, parseRecords, RecordsError, toMicros } from "./records.ts";

const one = { date: "2026-10-01", provider: "aws", account: "111", service: "Amazon S3", amount: 1.5, currency: "usd" };

describe("parseRecords", () => {
  it("reads a JSON array and { records }", () => {
    const a = parseRecords(JSON.stringify([one]), "application/json");
    expect(a).toEqual([{ date: "2026-10-01", provider: "aws", account: "111", service: "Amazon S3", region: "", resource: "", usageType: "", currency: "USD", micros: 1_500_000, tags: {} }]);
    expect(parseRecords(JSON.stringify({ records: [one] }), undefined)).toEqual(a);
    expect(parseRecords(JSON.stringify(one), undefined)).toEqual(a);
  });

  it("reads NDJSON by its type, and without a type when the whole body is not one JSON document", () => {
    const body = `${JSON.stringify(one)}\n${JSON.stringify({ ...one, date: "2026-10-02" })}\n`;
    expect(parseRecords(body, "application/x-ndjson").map((r) => r.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(parseRecords(body, "text/plain").map((r) => r.date)).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("reads CSV with quotes, and tag columns", () => {
    const csv = 'date,provider,account,service,amount,currency,tag:team,tags.env\n2026-10-01,gcp,p-1,"Compute, Engine",2.25,EUR,payments,prod\n2026-10-02,gcp,p-1,BigQuery,3,EUR,,\n';
    const r = parseRecords(csv, "text/csv; charset=utf-8");
    expect(r[0]).toMatchObject({ service: "Compute, Engine", micros: 2_250_000, tags: { team: "payments", env: "prod" } });
    expect(r[1]).toMatchObject({ service: "BigQuery", tags: {} });
    // "1,000.5" is not a number; amounts have no thousands separator.
    expect(() => parseRecords('date,provider,account,service,amount,currency\n2026-10-01,aws,1,S3,"1,000.5",USD\n', "text/csv")).toThrow(/Line 1: amount/);
  });

  it("handles quotes inside quotes and newlines inside a cell", () => {
    expect(parseCsv('a,b\n"x ""y""","line\none"\n')).toEqual([["a", "b"], ['x "y"', "line\none"]]);
  });

  it("names the line and the field that is wrong", () => {
    const bad = (o: object, re: RegExp) => expect(() => parseRecords(JSON.stringify([one, { ...one, ...o }]), undefined)).toThrow(re);
    bad({ date: "2026-13-01" }, /Line 2: date/);
    bad({ date: "yesterday" }, /Line 2: date/);
    bad({ provider: "oracle" }, /Line 2: provider/);
    bad({ amount: "abc" }, /Line 2: amount/);
    bad({ amount: null }, /Line 2: amount/);
    bad({ currency: "dollars" }, /Line 2: currency/);
    bad({ account: "" }, /Line 2: account is required/);
    bad({ service: "x".repeat(300) }, /Line 2: service is longer/);
    bad({ tags: ["a"] }, /Line 2: tags must be an object/);
    bad({ tags: { "bad key!": "x" } }, /Line 2: tag name/);
  });

  it("refuses bodies that are not records", () => {
    expect(() => parseRecords("[]", undefined)).toThrow(/no records/);
    expect(() => parseRecords("{nope", undefined)).toThrow(RecordsError);
    expect(() => parseRecords('"text"', undefined)).toThrow(/array of records/);
    expect(() => parseRecords("", "text/csv")).toThrow(/empty/);
  });

  it("drops empty tags and lower-cases tag names", () => {
    expect(parseRecords(JSON.stringify([{ ...one, tags: { Team: "pay", Env: "", Owner: null } }]), undefined)[0]!.tags).toEqual({ team: "pay" });
  });
});

describe("money and days", () => {
  it("turns amounts into exact millionths", () => {
    expect(toMicros(0.1) + toMicros(0.2)).toBe(toMicros(0.3));
    expect(toMicros(19.99)).toBe(19_990_000);
    expect(toMicros(-4.5)).toBe(-4_500_000);
  });
  it("knows a real day", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-2-3")).toBe(false);
    expect(isDay(20260101)).toBe(false);
  });
});
