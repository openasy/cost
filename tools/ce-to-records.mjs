#!/usr/bin/env node
// Turns the answer of `aws ce get-cost-and-usage` into the lines Cost takes at POST /api/v1/records.
//
//   aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-15 --granularity DAILY \
//     --metrics UnblendedCost \
//     --group-by Type=DIMENSION,Key=LINKED_ACCOUNT Type=DIMENSION,Key=SERVICE Type=TAG,Key=team \
//     | node tools/ce-to-records.mjs > records.json
//
// Group by LINKED_ACCOUNT and SERVICE at least; REGION, USAGE_TYPE and tags are kept when you group by them. Nothing
// here needs a package: it reads the answer on standard input (or a file given as the first argument).
import { readFileSync } from "node:fs";

const DIMENSIONS = { LINKED_ACCOUNT: "account", SERVICE: "service", REGION: "region", USAGE_TYPE: "usageType", RESOURCE_ID: "resource" };

/** Cost Explorer writes a tag group as "team$payments"; an empty value means the resource has no such tag. */
const tagValue = (key) => {
  const at = key.indexOf("$");
  return at === -1 ? "" : key.slice(at + 1);
};

/**
 * @param {any} ce the parsed answer, one page of it or several pages merged
 * @param {{ metric?: string, account?: string }} [options] `metric` picks one when the answer has several, `account`
 *   names the account when the answer was not grouped by LINKED_ACCOUNT
 */
export function convert(ce, options = {}) {
  if (!ce || !Array.isArray(ce.ResultsByTime)) throw new Error("This is not the answer of `aws ce get-cost-and-usage`: ResultsByTime is missing.");
  const defs = ce.GroupDefinitions ?? [];
  const out = [];
  for (const period of ce.ResultsByTime) {
    const date = period?.TimePeriod?.Start;
    if (!/^\d{4}-\d{2}-\d{2}/.test(date ?? "")) throw new Error("A result has no TimePeriod.Start.");
    // A monthly answer would put a whole month on its first day, which is wrong for a daily view.
    if (period.TimePeriod.End && Date.parse(period.TimePeriod.End) - Date.parse(period.TimePeriod.Start) > 86_400_000)
      throw new Error(`${date}: the answer is not daily; ask for --granularity DAILY.`);
    for (const group of period.Groups ?? []) {
      const metrics = group.Metrics ?? {};
      const name = options.metric ?? Object.keys(metrics)[0];
      const m = metrics[name];
      if (!m || m.Amount === undefined) throw new Error(`${date}: the metric ${name ?? "(none)"} is not in the answer.`);
      const record = {
        date: date.slice(0, 10),
        provider: "aws",
        account: options.account ?? "",
        service: "",
        amount: Number(m.Amount),
        currency: m.Unit ?? "USD",
        tags: {},
      };
      (group.Keys ?? []).forEach((key, i) => {
        const def = defs[i] ?? {};
        if (def.Type === "TAG") {
          const value = tagValue(key);
          if (value) record.tags[String(def.Key).toLowerCase()] = value;
        } else if (DIMENSIONS[def.Key]) record[DIMENSIONS[def.Key]] = key;
      });
      if (!record.account) throw new Error(`${date}: group by LINKED_ACCOUNT, or pass --account.`);
      if (!record.service) throw new Error(`${date}: group by SERVICE.`);
      if (!Number.isFinite(record.amount)) throw new Error(`${date}: ${record.service} has an amount that is not a number.`);
      out.push(record);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const ndjson = args.includes("--ndjson") && args.splice(args.indexOf("--ndjson"), 1).length > 0;
  const metric = option("metric");
  const account = option("account");
  try {
    const records = convert(JSON.parse(readFileSync(args[0] ?? 0, "utf8")), { metric, account });
    process.stdout.write(ndjson ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : JSON.stringify(records) + "\n");
  } catch (err) {
    process.stderr.write(`ce-to-records: ${err.message}\n`);
    process.exit(1);
  }
}
