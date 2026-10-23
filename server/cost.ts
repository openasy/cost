import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isDay, toMicros, type SpendRecord } from "./records.ts";

export type ProblemCode =
  "invalid-token" | "invalid-json" | "invalid-body" | "invalid-records" | "not-found" | "conflict" | "not-configured" | "payload-too-large" | "internal-error";

export class CostError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const bad = (detail: string) => new CostError(422, "invalid-body", detail);
const notFound = (what: string) => new CostError(404, "not-found", `${what} does not exist.`);
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ days and money

const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysInMonth = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const previousMonthOf = (day: string) => addDays(monthStart(day), -1);
const weekStart = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Millionths to a number with cents. Sums are done in millionths, only the answer is rounded. */
export const amountOf = (micros: number) => Math.round(micros / 10_000) / 100;

export type Provider = SpendRecord["provider"];

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

// ------------------------------------------------------------------ owners

export interface Rule {
  kind: "account" | "service" | "tag";
  match: string;
  tagKey: string | null;
  team: string;
}

const globToRe = (glob: string) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );
const TEAM = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/;
export const UNTAGGED = "untagged";

/** A team tag on the line wins; otherwise the first rule that matches; otherwise nobody owns it yet. */
export function resolveTeam(account: string, service: string, tags: Record<string, string>, rules: Rule[]): string | null {
  if (tags.team) return tags.team;
  for (const r of rules) {
    if (r.kind === "account" && account === r.match) return r.team;
    if (r.kind === "service" && globToRe(r.match).test(service)) return r.team;
    if (r.kind === "tag" && r.tagKey && tags[r.tagKey.toLowerCase()] === r.match) return r.team;
  }
  return null;
}

// ------------------------------------------------------------------ spend

export interface SpendFilter {
  from?: string;
  to?: string;
  provider?: string;
  account?: string;
  service?: string;
  region?: string;
  /** A team, or "untagged" for spend nobody owns yet. */
  team?: string;
  tags?: Record<string, string>;
}

const GROUPS = ["team", "service", "account", "provider", "region", "day", "week", "month"];
export const isGroupBy = (g: string) => GROUPS.includes(g) || /^tag:[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/.test(g);

export interface CostOptions {
  /** Spend and anomalies older than this many days are deleted (ADR 0015). */
  retentionDays?: number;
}

export function createCost(db: DatabaseSync, { retentionDays = 800 }: CostOptions = {}) {
  const setting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const put = (key: string, value: string) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);

  const currency = () => setting("currency") ?? "USD";
  const anomalyMinimum = () => Number(setting("anomaly_minimum") ?? 50);
  const ratesMap = () =>
    new Map((db.prepare("SELECT currency, rate FROM rates").all() as Array<{ currency: string; rate: number }>).map((r) => [r.currency, r.rate]));
  const rules = (): Rule[] =>
    (
      db.prepare("SELECT kind, match, tag_key, team FROM rules ORDER BY position").all() as Array<{
        kind: Rule["kind"];
        match: string;
        tag_key: string | null;
        team: string;
      }>
    ).map((r) => ({ kind: r.kind, match: r.match, tagKey: r.tag_key, team: r.team }));
  const latestDate = () => (db.prepare("SELECT MAX(date) AS d FROM records").get() as { d: string | null }).d;

  /** The money of a line in the reporting currency, or null when no rate says what its currency is worth. */
  const convert = (micros: number, from: string, rates: Map<string, number>, reporting: string) =>
    from === reporting ? micros : rates.has(from) ? Math.round(micros * rates.get(from)!) : null;

  function resolveAll() {
    const rs = rules();
    const rows = db.prepare("SELECT DISTINCT account, service, tags FROM records").all() as Array<{ account: string; service: string; tags: string }>;
    const upd = db.prepare("UPDATE records SET team = ? WHERE account = ? AND service = ? AND tags = ?");
    for (const r of rows) upd.run(resolveTeam(r.account, r.service, JSON.parse(r.tags) as Record<string, string>, rs), r.account, r.service, r.tags);
  }

  // -------------------------------------------------------------- anomalies

  /** Days of one service in one account, in the reporting currency. Days with a currency nobody has a rate for are left out. */
  function dayTotals(account: string, service: string, from: string, to: string) {
    const rates = ratesMap();
    const reporting = currency();
    const out = new Map<string, number>();
    const rows = db
      .prepare("SELECT date, currency, SUM(micros) AS m FROM records WHERE account = ? AND service = ? AND date BETWEEN ? AND ? GROUP BY date, currency")
      .all(account, service, from, to) as Array<{ date: string; currency: string; m: number }>;
    for (const r of rows) {
      const c = convert(r.m, r.currency, rates, reporting);
      if (c !== null) out.set(r.date, (out.get(r.date) ?? 0) + c);
    }
    return out;
  }

  const WINDOW = 14;
  const MIN_HISTORY = 7;

  /** A day is odd when it costs more than the mean of the 14 days before it plus three standard deviations, and by enough to matter. */
  function detect(account: string, service: string, dates: string[]) {
    if (!dates.length) return;
    const sorted = [...dates].sort();
    const totals = dayTotals(account, service, addDays(sorted[0]!, -WINDOW), sorted[sorted.length - 1]!);
    const minimum = toMicros(anomalyMinimum());
    for (const date of sorted) {
      const today = totals.get(date);
      if (today === undefined) continue;
      const prior: number[] = [];
      let seen = 0;
      for (let i = 1; i <= WINDOW; i++) {
        const v = totals.get(addDays(date, -i));
        if (v !== undefined) seen++;
        prior.push(v ?? 0);
      }
      const mean = prior.reduce((a, b) => a + b, 0) / WINDOW;
      const sd = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / WINDOW);
      const odd = seen >= MIN_HISTORY && today > mean + 3 * sd && today - mean >= minimum;
      if (odd) {
        db.prepare(
          `INSERT INTO anomalies (id, date, account, service, micros, mean_micros, sd_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (date, account, service) DO UPDATE SET micros = excluded.micros, mean_micros = excluded.mean_micros, sd_micros = excluded.sd_micros`,
        ).run(randomUUID(), date, account, service, today, Math.round(mean), Math.round(sd), now());
      } else {
        db.prepare("DELETE FROM anomalies WHERE date = ? AND account = ? AND service = ? AND status = 'new'").run(date, account, service);
      }
    }
  }

  // -------------------------------------------------------------- queries

  function where(f: SpendFilter) {
    const w: string[] = [];
    const a: SQLInputValue[] = [];
    if (f.from) (w.push("date >= ?"), a.push(f.from));
    if (f.to) (w.push("date <= ?"), a.push(f.to));
    for (const col of ["provider", "account", "service", "region"] as const) if (f[col]) (w.push(`${col} = ?`), a.push(f[col]!));
    if (f.team) f.team === UNTAGGED ? w.push("team IS NULL") : (w.push("team = ?"), a.push(f.team));
    for (const [k, v] of Object.entries(f.tags ?? {})) (w.push("json_extract(tags, ?) = ?"), a.push(`$."${k.toLowerCase()}"`, v));
    return { sql: w.length ? `WHERE ${w.join(" AND ")}` : "", args: a };
  }

  /** Spend in millionths of the reporting currency by the key `groupBy` gives each line. Also names the currencies nobody has a rate for. */
  function aggregate(groupBy: string, f: SpendFilter) {
    const { sql, args } = where(f);
    const dim =
      groupBy === "team"
        ? "COALESCE(team, 'untagged')"
        : groupBy.startsWith("tag:")
          ? "COALESCE(json_extract(tags, ?), 'untagged')"
          : ["service", "account", "provider", "region"].includes(groupBy)
            ? groupBy
            : "''";
    const extra: SQLInputValue[] = groupBy.startsWith("tag:") ? [`$."${groupBy.slice(4).toLowerCase()}"`] : [];
    const rows = db
      .prepare(`SELECT ${dim} AS k, date, currency, SUM(micros) AS m FROM records ${sql} GROUP BY k, date, currency`)
      .all(...extra, ...args) as Array<{ k: string; date: string; currency: string; m: number }>;
    const rates = ratesMap();
    const reporting = currency();
    const missing = new Set<string>();
    const groups = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      const c = convert(r.m, r.currency, rates, reporting);
      if (c === null) {
        missing.add(r.currency);
        continue;
      }
      const key = groupBy === "day" ? r.date : groupBy === "week" ? weekStart(r.date) : groupBy === "month" ? r.date.slice(0, 7) : r.k;
      groups.set(key, (groups.get(key) ?? 0) + c);
      total += c;
    }
    return { groups, total, missing: [...missing].sort() };
  }

  function range(f: SpendFilter, asOf = latestDate()): Required<Pick<SpendFilter, "from" | "to">> {
    const to = f.to ?? asOf ?? now().slice(0, 10);
    return { from: f.from ?? monthStart(to), to };
  }

  function spend(groupBy: string, f: SpendFilter) {
    if (!isGroupBy(groupBy)) throw bad(`groupBy must be one of ${GROUPS.join(", ")}, or tag:<name>.`);
    const r = range(f);
    if (r.from > r.to) throw bad("from must not be after to.");
    const filter = { ...f, ...r };
    const { groups, total, missing } = aggregate(groupBy, filter);
    // What nobody owns yet, across the whole filter (except a team filter, which already says whose).
    const untagged = f.team ? null : (aggregate("team", filter).groups.get(UNTAGGED) ?? 0);
    const period = groupBy === "day" || groupBy === "week" || groupBy === "month";
    const list = [...groups].map(([key, m]) => ({ key, amount: amountOf(m), share: total ? Math.round((m / total) * 10_000) / 10_000 : 0 }));
    list.sort(period ? (a, b) => (a.key < b.key ? -1 : 1) : (a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1));
    return {
      currency: currency(),
      from: r.from,
      to: r.to,
      groupBy,
      total: amountOf(total),
      untagged: untagged === null ? null : { amount: amountOf(untagged), share: total ? Math.round((untagged / total) * 10_000) / 10_000 : 0 },
      groups: list,
      missingRates: missing,
    };
  }

  /** The same length of time just before `from`, to see what moved. */
  function movers(groupBy: string, f: SpendFilter) {
    if (!isGroupBy(groupBy) || groupBy === "day" || groupBy === "week" || groupBy === "month")
      throw bad("groupBy must be team, service, account, provider, region or tag:<name>.");
    const r = range(f);
    if (r.from > r.to) throw bad("from must not be after to.");
    const length = daysBetween(r.from, r.to) + 1;
    const before = { from: addDays(r.from, -length), to: addDays(r.from, -1) };
    const cur = aggregate(groupBy, { ...f, ...r });
    const prev = aggregate(groupBy, { ...f, ...before });
    const keys = new Set([...cur.groups.keys(), ...prev.groups.keys()]);
    const items = [...keys].map((key) => {
      const c = cur.groups.get(key) ?? 0;
      const p = prev.groups.get(key) ?? 0;
      return { key, current: amountOf(c), previous: amountOf(p), change: amountOf(c - p), changePercent: p ? Math.round(((c - p) / p) * 1000) / 10 : null };
    });
    items.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || (a.key < b.key ? -1 : 1));
    return {
      currency: currency(),
      period: r,
      previousPeriod: before,
      groupBy,
      movers: items.slice(0, 10),
      missingRates: [...new Set([...cur.missing, ...prev.missing])].sort(),
    };
  }

  /** Spend so far this month, the run rate of the last 7 days, and where the month ends if that rate holds. */
  function forecastFor(f: SpendFilter, asOf: string) {
    const start = monthStart(asOf);
    const spent = aggregate("provider", { ...f, from: start, to: asOf }).total;
    const week = aggregate("provider", { ...f, from: addDays(asOf, -6), to: asOf }).total;
    const remaining = daysInMonth(asOf) - Number(asOf.slice(8, 10));
    const runRate = week / 7;
    return { spent, runRate, remainingDays: remaining, forecast: Math.round(spent + runRate * remaining) };
  }

  const asOfOf = (asOf?: string) => {
    if (asOf !== undefined && !isDay(asOf)) throw bad("asOf must be a day, such as 2026-10-21.");
    return asOf ?? latestDate() ?? now().slice(0, 10);
  };

  return {
    currency,
    latestDate,
    resolveAll,
    forecastFor,
    spend,
    movers,
    asOfOf,
    // ---------------------------------------------------------- settings, rates and rules
    settings: () => ({ currency: currency(), anomalyMinimum: anomalyMinimum() }),
    updateSettings(body: Record<string, unknown>) {
      const { currency: cur, anomalyMinimum: min, ...rest } = body;
      if (Object.keys(rest).length || (cur === undefined && min === undefined)) throw bad("Expected { currency?, anomalyMinimum? }.");
      if (cur !== undefined) {
        if (typeof cur !== "string" || !/^[A-Z]{3}$/.test(cur)) throw bad("currency must be a three-letter code such as USD.");
        db.prepare("DELETE FROM rates WHERE currency = ?").run(cur); // the reporting currency is worth exactly itself
        put("currency", cur);
      }
      if (min !== undefined) {
        if (typeof min !== "number" || !Number.isFinite(min) || min < 0 || min > 1e9) throw bad("anomalyMinimum must be a number of at least 0.");
        put("anomaly_minimum", String(min));
      }
      return { currency: currency(), anomalyMinimum: anomalyMinimum() };
    },
    rates: () => ({
      currency: currency(),
      rates: (db.prepare("SELECT currency, rate FROM rates ORDER BY currency").all() as Array<{ currency: string; rate: number }>).map((r) => ({
        currency: r.currency,
        rate: r.rate,
      })),
    }),
    setRate(code: string, body: Record<string, unknown>) {
      if (!/^[A-Z]{3}$/.test(code)) throw bad("The currency must be a three-letter code such as EUR.");
      if (code === currency()) throw bad(`${code} is the reporting currency; it is worth exactly itself.`);
      const { rate, ...rest } = body;
      if (Object.keys(rest).length || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1e9)
        throw bad(`Expected { rate }: what one ${code} is worth in ${currency()}, above 0.`);
      db.prepare("INSERT INTO rates (currency, rate) VALUES (?, ?) ON CONFLICT (currency) DO UPDATE SET rate = excluded.rate").run(code, rate);
      return { currency: code, rate };
    },
    deleteRate(code: string) {
      if (db.prepare("DELETE FROM rates WHERE currency = ?").run(code).changes === 0) throw notFound("The rate");
    },
    rules: () => ({ rules: rules() }),
    replaceRules(body: Record<string, unknown>) {
      const list = body.rules;
      if (Object.keys(body).length !== 1 || !Array.isArray(list) || list.length > 200) throw bad("Expected { rules: [...] } with at most 200 rules.");
      const clean = list.map((r, i): Rule => {
        const o = r as Record<string, unknown>;
        if (!o || typeof o !== "object" || Array.isArray(o)) throw bad(`Rule ${i + 1} must be an object.`);
        const { kind, match, tagKey, team, ...rest } = o;
        if (Object.keys(rest).length || (kind !== "account" && kind !== "service" && kind !== "tag"))
          throw bad(`Rule ${i + 1}: kind is account, service or tag.`);
        if (typeof match !== "string" || !match.trim() || match.length > 128) throw bad(`Rule ${i + 1}: match is required.`);
        if (typeof team !== "string" || !TEAM.test(team) || team.toLowerCase() === UNTAGGED)
          throw bad(`Rule ${i + 1}: team is a name of up to 64 letters, digits, spaces and . _ / -, and not "${UNTAGGED}".`);
        if (kind === "tag" && (typeof tagKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/.test(tagKey)))
          throw bad(`Rule ${i + 1}: a tag rule needs tagKey.`);
        if (kind !== "tag" && tagKey !== undefined && tagKey !== null) throw bad(`Rule ${i + 1}: tagKey belongs to tag rules.`);
        return { kind, match: match.trim(), tagKey: kind === "tag" ? (tagKey as string) : null, team };
      });
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM rules");
        const ins = db.prepare("INSERT INTO rules (id, position, kind, match, tag_key, team) VALUES (?, ?, ?, ?, ?, ?)");
        clean.forEach((r, i) => ins.run(randomUUID(), i, r.kind, r.match, r.tagKey, r.team));
        resolveAll();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { rules: rules() };
    },
    // ---------------------------------------------------------- records in
    /**
     * Lines with the same key in one call are added together (a bill has many lines for one resource and day). A line
     * that already exists is replaced, so sending a day again does not count it twice. With `replace`, the days in the
     * call are cleared first for their provider and account, so lines the new export no longer has disappear.
     */
    ingest(records: SpendRecord[], { replace = false }: { replace?: boolean } = {}) {
      const rs = rules();
      const merged = new Map<string, SpendRecord>();
      for (const r of records) {
        const key = JSON.stringify([r.date, r.provider, r.account, r.service, r.region, r.resource, r.usageType, r.currency]);
        const have = merged.get(key);
        if (have) ((have.micros += r.micros), Object.assign(have.tags, r.tags));
        else merged.set(key, { ...r, tags: { ...r.tags } });
      }
      let replaced = 0;
      const affected = new Map<string, Set<string>>();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (replace) {
          const del = db.prepare("DELETE FROM records WHERE provider = ? AND account = ? AND date = ?");
          const seen = new Set<string>();
          for (const r of merged.values()) {
            const k = `${r.provider}|${r.account}|${r.date}`;
            if (!seen.has(k)) (seen.add(k), del.run(r.provider, r.account, r.date));
          }
        }
        const has = db.prepare(
          "SELECT 1 FROM records WHERE date = ? AND provider = ? AND account = ? AND service = ? AND region = ? AND resource = ? AND usage_type = ? AND currency = ?",
        );
        const upsert = db.prepare(
          `INSERT INTO records (date, provider, account, service, region, resource, usage_type, currency, micros, tags, team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (date, provider, account, service, region, resource, usage_type, currency) DO UPDATE SET micros = excluded.micros, tags = excluded.tags, team = excluded.team`,
        );
        for (const r of merged.values()) {
          if (has.get(r.date, r.provider, r.account, r.service, r.region, r.resource, r.usageType, r.currency)) replaced++;
          const tags = JSON.stringify(Object.fromEntries(Object.entries(r.tags).sort(([a], [b]) => (a < b ? -1 : 1))));
          upsert.run(
            r.date,
            r.provider,
            r.account,
            r.service,
            r.region,
            r.resource,
            r.usageType,
            r.currency,
            r.micros,
            tags,
            resolveTeam(r.account, r.service, r.tags, rs),
          );
          const k = JSON.stringify([r.account, r.service]);
          (affected.get(k) ?? affected.set(k, new Set()).get(k)!).add(r.date);
        }
        // Days that were cleared and not sent again may have taken an anomaly with them.
        for (const [k, dates] of affected) {
          const [account, service] = JSON.parse(k) as [string, string];
          detect(account, service, [...dates]);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      const dates = [...merged.values()].map((r) => r.date).sort();
      const open = (db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE status = 'new'").get() as { n: number }).n;
      return { received: records.length, lines: merged.size, replaced, from: dates[0]!, to: dates[dates.length - 1]!, anomaliesOpen: open };
    },
    // ---------------------------------------------------------- budgets
    createBudget(body: Record<string, unknown>) {
      const { name, scope, tagKey, value, amount, ...rest } = body;
      if (Object.keys(rest).length || typeof name !== "string" || !name.trim() || name.length > 64)
        throw bad("Expected { name, scope, value, amount, tagKey? }; name is up to 64 characters.");
      if (scope !== "team" && scope !== "tag") throw bad("scope is team or tag.");
      if (typeof value !== "string" || !value.trim() || value.length > 128) throw bad("value is the team, or the tag value.");
      if (scope === "tag" && (typeof tagKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/.test(tagKey))) throw bad("A tag budget needs tagKey.");
      if (scope === "team" && tagKey !== undefined && tagKey !== null) throw bad("tagKey belongs to tag budgets.");
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1e12)
        throw bad(`amount is a monthly amount in ${currency()}, above 0.`);
      if (db.prepare("SELECT 1 FROM budgets WHERE name = ?").get(name.trim())) throw new CostError(409, "conflict", "A budget with this name exists.");
      const id = randomUUID();
      db.prepare("INSERT INTO budgets (id, name, scope, tag_key, value, micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        name.trim(),
        scope,
        scope === "tag" ? (tagKey as string) : null,
        value.trim(),
        toMicros(amount),
        now(),
      );
      return this.budget(id);
    },
    budget(id: string, asOfInput?: string) {
      const b = db.prepare("SELECT * FROM budgets WHERE id = ?").get(id) as
        { id: string; name: string; scope: "team" | "tag"; tag_key: string | null; value: string; micros: number } | undefined;
      if (!b) throw notFound("The budget");
      const asOf = asOfOf(asOfInput);
      const filter: SpendFilter = b.scope === "team" ? { team: b.value } : { tags: { [b.tag_key!]: b.value } };
      const f = forecastFor(filter, asOf);
      const percent = (f.spent / b.micros) * 100;
      // 1 is on the straight line from the first day to the last; above 1 the budget runs out before the month does.
      const pace = (b.micros * Number(asOf.slice(8, 10))) / daysInMonth(asOf);
      const reached = percent >= 100 ? 100 : percent >= 80 ? 80 : percent >= 50 ? 50 : null;
      return {
        id: b.id,
        name: b.name,
        scope: b.scope,
        tagKey: b.tag_key,
        value: b.value,
        amount: amountOf(b.micros),
        month: asOf.slice(0, 7),
        asOf,
        spent: amountOf(f.spent),
        percent: Math.round(percent * 10) / 10,
        burnRate: Math.round((f.spent / pace) * 100) / 100,
        forecast: amountOf(f.forecast),
        forecastPercent: Math.round((f.forecast / b.micros) * 1000) / 10,
        thresholds: [50, 80, 100],
        reached,
        state: reached === 100 ? ("over" as const) : reached === 80 ? ("alert" as const) : reached === 50 ? ("warning" as const) : ("ok" as const),
        currency: currency(),
      };
    },
    budgets(asOf?: string) {
      const ids = db.prepare("SELECT id FROM budgets ORDER BY name").all() as Array<{ id: string }>;
      return { budgets: ids.map((r) => this.budget(r.id, asOf)) };
    },
    deleteBudget(id: string) {
      if (db.prepare("DELETE FROM budgets WHERE id = ?").run(id).changes === 0) throw notFound("The budget");
    },
    // ---------------------------------------------------------- anomalies
    anomalies(status: string | null, cursor: string | undefined, limit: number) {
      if (status !== null && status !== "new" && status !== "acknowledged" && status !== "expected") throw bad("status is new, acknowledged or expected.");
      const offset = decodeCursor(cursor);
      const rows = db
        .prepare(`SELECT * FROM anomalies ${status ? "WHERE status = ?" : ""} ORDER BY date DESC, micros DESC LIMIT ? OFFSET ?`)
        .all(...((status ? [status] : []) as SQLInputValue[]), limit + 1, offset) as Array<Record<string, any>>;
      const items = rows.slice(0, limit).map((r) => ({
        id: r.id as string,
        date: r.date as string,
        account: r.account as string,
        service: r.service as string,
        amount: amountOf(r.micros),
        usual: amountOf(r.mean_micros),
        deviation: amountOf(r.sd_micros),
        extra: amountOf(r.micros - r.mean_micros),
        status: r.status as "new" | "acknowledged" | "expected",
        reason: (r.reason as string | null) ?? null,
        decidedBy: (r.decided_by as string | null) ?? null,
        decidedAt: (r.decided_at as string | null) ?? null,
        currency: currency(),
      }));
      return { items, ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) } satisfies Page<unknown>;
    },
    decideAnomaly(id: string, body: Record<string, unknown>, by: string) {
      const { status, reason, ...rest } = body;
      if (Object.keys(rest).length || (status !== "new" && status !== "acknowledged" && status !== "expected"))
        throw bad("Expected { status, reason? }; status is new, acknowledged or expected.");
      if (!db.prepare("SELECT 1 FROM anomalies WHERE id = ?").get(id)) throw notFound("The anomaly");
      // "Expected" is a decision other people will rely on, so it says why.
      if (status === "expected" && (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500))
        throw bad("reason is required for expected: 3 to 500 characters.");
      if (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > 500)) throw bad("reason is at most 500 characters.");
      db.prepare("UPDATE anomalies SET status = ?, reason = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(
        status,
        status === "new" ? null : ((reason as string | undefined)?.trim() ?? null),
        status === "new" ? null : by,
        status === "new" ? null : now(),
        id,
      );
      return this.anomalies(null, undefined, 500).items.find((a) => a.id === id)!;
    },
    // ---------------------------------------------------------- overview and metrics
    summary(asOfInput?: string) {
      const asOf = asOfOf(asOfInput);
      const start = monthStart(asOf);
      const f = forecastFor({}, asOf);
      const prevEnd = previousMonthOf(asOf);
      const previous = aggregate("provider", { from: monthStart(prevEnd), to: prevEnd });
      const teams = aggregate("team", { from: start, to: asOf });
      const services = aggregate("service", { from: start, to: asOf });
      const top = (m: Map<string, number>) =>
        [...m]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, 5)
          .map(([key, v]) => ({ key, amount: amountOf(v) }));
      const untagged = teams.groups.get(UNTAGGED) ?? 0;
      const budgets = this.budgets(asOf).budgets;
      return {
        currency: currency(),
        asOf,
        month: asOf.slice(0, 7),
        hasData: latestDate() !== null,
        monthToDate: amountOf(f.spent),
        forecast: amountOf(f.forecast),
        dailyRunRate: amountOf(Math.round(f.runRate)),
        previousMonth: amountOf(previous.total),
        topTeams: top(teams.groups),
        topServices: top(services.groups),
        untaggedShare: teams.total ? Math.round((untagged / teams.total) * 10_000) / 10_000 : 0,
        anomaliesOpen: (db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE status = 'new'").get() as { n: number }).n,
        budgetsAtRisk: budgets.filter((b) => b.state !== "ok" || b.forecastPercent >= 100).length,
        missingRates: [...new Set([...teams.missing, ...previous.missing])].sort(),
      };
    },
    gauges() {
      const asOf = asOfOf();
      const teams = aggregate("team", { from: monthStart(asOf), to: asOf });
      return {
        currency: currency(),
        monthToDate: Object.fromEntries([...teams.groups].map(([k, v]) => [k, amountOf(v)])),
        budgets: this.budgets(asOf).budgets.map((b) => ({ name: b.name, percent: b.percent, burnRate: b.burnRate })),
        anomaliesOpen: (db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE status = 'new'").get() as { n: number }).n,
      };
    },
    purge() {
      const before = addDays(now().slice(0, 10), -retentionDays);
      db.prepare("DELETE FROM records WHERE date < ?").run(before);
      db.prepare("DELETE FROM anomalies WHERE date < ?").run(before);
    },
  };
}

export type Cost = ReturnType<typeof createCost>;
