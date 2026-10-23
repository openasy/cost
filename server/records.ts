// Reads the spend lines a pipeline sends: a JSON array, NDJSON or CSV, in a shape close to FOCUS (ADR 0051).

export const PROVIDERS = ["aws", "gcp", "azure", "other"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface SpendRecord {
  date: string;
  provider: Provider;
  account: string;
  service: string;
  region: string;
  resource: string;
  usageType: string;
  currency: string;
  /** Millionths of the currency, so sums are exact. */
  micros: number;
  tags: Record<string, string>;
}

export class RecordsError extends Error {}

/** Most lines one call may hold. A year of a large estate in daily lines is far less. */
export const MAX_ROWS = 200_000;
const MAX_TAGS = 20;
const MAX_TEXT = 256;

type Row = Record<string, unknown>;

export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(value);
}

/** Money to millionths, the nearest one. */
export const toMicros = (amount: number) => Math.round(amount * 1e6);

function text(value: unknown, field: string, index: number, required = false): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new RecordsError(`Line ${index + 1}: ${field} is required.`);
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") throw new RecordsError(`Line ${index + 1}: ${field} must be text.`);
  const s = String(value).trim();
  if (s.length > MAX_TEXT) throw new RecordsError(`Line ${index + 1}: ${field} is longer than ${MAX_TEXT} characters.`);
  if (required && !s) throw new RecordsError(`Line ${index + 1}: ${field} is required.`);
  return s;
}

function line(row: Row, index: number): SpendRecord {
  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new RecordsError(`Line ${index + 1}: expected an object.`);
  if (!isDay(row.date)) throw new RecordsError(`Line ${index + 1}: date must be a day, such as 2026-10-21.`);
  const provider = String(row.provider ?? "").toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new RecordsError(`Line ${index + 1}: provider must be one of ${PROVIDERS.join(", ")}.`);
  const amount = typeof row.amount === "string" && row.amount.trim() !== "" ? Number(row.amount) : row.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || Math.abs(amount) >= 1e12) throw new RecordsError(`Line ${index + 1}: amount must be a number.`);
  const currency = String(row.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new RecordsError(`Line ${index + 1}: currency must be a three-letter code such as USD.`);
  const tags: Record<string, string> = {};
  if (row.tags !== undefined && row.tags !== null) {
    if (typeof row.tags !== "object" || Array.isArray(row.tags)) throw new RecordsError(`Line ${index + 1}: tags must be an object.`);
    const entries = Object.entries(row.tags as Row);
    if (entries.length > MAX_TAGS) throw new RecordsError(`Line ${index + 1}: at most ${MAX_TAGS} tags.`);
    for (const [k, v] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/.test(k))
        throw new RecordsError(`Line ${index + 1}: tag name ${JSON.stringify(k.slice(0, 40))} is not allowed.`);
      if (v === null || v === undefined || v === "") continue; // an empty tag is no tag
      tags[k.toLowerCase()] = text(v, `tag ${k}`, index);
    }
  }
  return {
    date: row.date,
    provider: provider as Provider,
    account: text(row.account, "account", index, true),
    service: text(row.service, "service", index, true),
    region: text(row.region, "region", index),
    resource: text(row.resource, "resource", index),
    usageType: text(row.usageType, "usageType", index),
    currency,
    micros: toMicros(amount),
    tags,
  };
}

/** One CSV record: quotes, doubled quotes inside them, commas and newlines inside quotes. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') ((cell += '"'), i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

function fromCsv(input: string): Row[] {
  const [header, ...body] = parseCsv(input.replace(/^﻿/, ""));
  if (!header) throw new RecordsError("The CSV is empty.");
  const names = header.map((h) => h.trim());
  return body.map((cells) => {
    const row: Row = { tags: {} as Record<string, string> };
    names.forEach((name, i) => {
      const value = cells[i] ?? "";
      if (/^tags?[:.]/i.test(name)) (row.tags as Record<string, string>)[name.replace(/^tags?[:.]/i, "")] = value;
      else row[name] = value;
    });
    return row;
  });
}

const ndjson = (body: string): Row[] =>
  body
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);

/** Reads the body by its content type. Without a useful one, a JSON document is tried first and then one object per line. */
export function parseRecords(body: string, contentType: string | undefined): SpendRecord[] {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  let rows: Row[];
  try {
    if (type === "text/csv") rows = fromCsv(body);
    else if (type === "application/x-ndjson" || type === "application/ndjson") rows = ndjson(body);
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) rows = ndjson(body);
      else if (Array.isArray(parsed)) rows = parsed as Row[];
      else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Row).records)) rows = (parsed as Row).records as Row[];
      else if (parsed && typeof parsed === "object" && "date" in parsed) rows = [parsed as Row];
      else throw new RecordsError("Send a JSON array of records, or { records: [...] }.");
    }
  } catch (err) {
    if (err instanceof RecordsError) throw err;
    throw new RecordsError(type === "text/csv" ? "The CSV could not be read." : "The body is not JSON, NDJSON or CSV.");
  }
  if (rows.length > MAX_ROWS) throw new RecordsError(`A call may hold at most ${MAX_ROWS} lines.`);
  if (!rows.length) throw new RecordsError("There are no records in the body.");
  return rows.map((row, i) => line(row, i));
}
