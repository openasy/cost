import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { days, lines, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const put = (path: string, body: unknown) => app.admin(path, { method: "PUT", body: JSON.stringify(body) });
const post = (path: string, body: unknown) => app.admin(path, { method: "POST", body: JSON.stringify(body) });

// 14 days of October: the platform team's servers are tagged, the data account is not (a rule will own it), RDS has no owner.
const october = lines(
  ...days("2026-10-01", 14, 100, { tags: { team: "platform", env: "prod" } }),
  ...days("2026-10-01", 14, 10, { account: "222", service: "Amazon S3", tags: { env: "prod" } }),
  ...days("2026-10-01", 14, 5, { account: "333", service: "Amazon RDS" }),
);

describe("spend in", () => {
  it("takes lines and answers with what it kept", async () => {
    const res = await app.send(october);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 42, lines: 42, replaced: 0, from: "2026-10-01", to: "2026-10-14", anomaliesOpen: 0 });
  });

  it("does not count a day twice when it is sent again", async () => {
    const again = await (await app.send(october)).json();
    expect(again).toMatchObject({ received: 42, lines: 42, replaced: 42 });
    expect((await app.get("/api/v1/spend?groupBy=provider")).total).toBe(1610);
  });

  it("adds lines with the same key in one call, as a bill with many lines for one resource does", async () => {
    await app.send(
      lines(
        { date: "2026-09-01", account: "444", service: "Amazon SQS", amount: 1.1, resource: "q1" },
        { date: "2026-09-01", account: "444", service: "Amazon SQS", amount: 2.2, resource: "q1" },
      ),
    );
    const r = await app.get("/api/v1/spend?groupBy=service&account=444&from=2026-09-01&to=2026-09-01");
    expect(r.groups).toEqual([{ key: "Amazon SQS", amount: 3.3, share: 1 }]);
    await app.admin("/api/v1/spend?groupBy=day"); // reads do not change anything
  });

  it("replaces the days of a provider and account when asked, so lines the export no longer has disappear", async () => {
    await app.send(lines({ date: "2026-08-01", account: "555", service: "A", amount: 10 }, { date: "2026-08-01", account: "555", service: "B", amount: 20 }));
    await app.send(lines({ date: "2026-08-01", account: "555", service: "A", amount: 12 }), "?replace=true");
    const r = await app.get("/api/v1/spend?groupBy=service&account=555&from=2026-08-01&to=2026-08-01");
    expect(r.groups).toEqual([{ key: "A", amount: 12, share: 1 }]);
  });

  it("takes NDJSON, CSV and gzip", async () => {
    const row = { provider: "gcp", account: "p1", service: "BigQuery", currency: "USD", amount: 7, date: "2026-07-01" };
    expect(
      (await app.send(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, date: "2026-07-02" })}\n`, "", { "content-type": "application/x-ndjson" })).status,
    ).toBe(200);
    expect(
      (await app.send("date,provider,account,service,amount,currency\n2026-07-03,gcp,p1,BigQuery,7,USD\n", "", { "content-type": "text/csv" })).status,
    ).toBe(200);
    expect((await app.send(gzipSync(JSON.stringify([{ ...row, date: "2026-07-04" }])), "", { "content-encoding": "gzip" })).status).toBe(200);
    expect((await app.get("/api/v1/spend?groupBy=provider&provider=gcp&from=2026-07-01&to=2026-07-31")).total).toBe(28);
  });

  it("says which line is wrong and keeps nothing of the call", async () => {
    const before = (await app.get("/api/v1/spend?groupBy=provider&from=2026-06-01&to=2026-06-30")).total;
    const res = await app.send(
      JSON.stringify([
        { provider: "aws", account: "1", service: "S3", currency: "USD", amount: 1, date: "2026-06-01" },
        { provider: "aws", account: "1", service: "S3", currency: "USD", amount: "x", date: "2026-06-02" },
      ]),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "invalid-records", detail: "Line 2: amount must be a number." });
    expect((await app.get("/api/v1/spend?groupBy=provider&from=2026-06-01&to=2026-06-30")).total).toBe(before);
    expect((await app.send(lines({ date: "2026-06-01", amount: 1 }), "?replace=maybe")).status).toBe(422);
    expect((await app.send(lines({ date: "2026-06-01", amount: 1 }), "", { "content-encoding": "br" })).status).toBe(400);
  });
});

describe("who spent it", () => {
  it("shows what nobody owns yet", async () => {
    const r = await app.get("/api/v1/spend?groupBy=team&from=2026-10-01&to=2026-10-14");
    expect(r.groups.map((g: any) => [g.key, g.amount])).toEqual([
      ["platform", 1400],
      ["untagged", 210],
    ]);
    expect(r.untagged).toEqual({ amount: 210, share: 0.1304 });
    expect(r.total).toBe(1610);
  });

  it("gives untagged spend an owner by the first rule that matches, and a team tag wins over any rule", async () => {
    const rules = [
      { kind: "account", match: "222", team: "data" },
      { kind: "service", match: "amazon r*", team: "databases" },
      { kind: "account", match: "111", team: "wrong" },
    ];
    const res = await put("/api/v1/rules", { rules });
    expect(res.status).toBe(200);
    const r = await app.get("/api/v1/spend?groupBy=team&from=2026-10-01&to=2026-10-14");
    expect(r.groups.map((g: any) => [g.key, g.amount])).toEqual([
      ["platform", 1400],
      ["data", 140],
      ["databases", 70],
    ]);
    expect(r.untagged.amount).toBe(0);
    // New lines are placed by the same rules, as they arrive.
    await app.send(lines({ date: "2026-10-15", account: "222", service: "Amazon S3", amount: 10 }));
    expect((await app.get("/api/v1/spend?groupBy=team&from=2026-10-15&to=2026-10-15")).groups).toEqual([{ key: "data", amount: 10, share: 1 }]);
  });

  it("matches tag rules, and refuses rules it cannot read", async () => {
    expect((await put("/api/v1/rules", { rules: [{ kind: "tag", tagKey: "env", match: "prod", team: "prodteam" }] })).status).toBe(200);
    const r = await app.get("/api/v1/spend?groupBy=team&from=2026-10-01&to=2026-10-14");
    expect(r.groups.map((g: any) => g.key).sort()).toEqual(["platform", "prodteam", "untagged"]);
    for (const bad of [
      { rules: [{ kind: "region", match: "x", team: "t" }] },
      { rules: [{ kind: "tag", match: "prod", team: "t" }] },
      { rules: [{ kind: "account", match: "1", team: "untagged" }] },
      { rules: [{ kind: "account", match: "", team: "t" }] },
      { rules: [{ kind: "account", match: "1", team: "t", tagKey: "env" }] },
      { rules: "nope" },
      { rules: [], extra: 1 },
    ])
      expect((await put("/api/v1/rules", bad)).status, JSON.stringify(bad)).toBe(422);
    await put("/api/v1/rules", {
      rules: [
        { kind: "account", match: "222", team: "data" },
        { kind: "service", match: "Amazon R*", team: "databases" },
      ],
    });
  });

  it("groups by service, tag and period, and filters", async () => {
    const q = "from=2026-10-01&to=2026-10-14";
    expect((await app.get(`/api/v1/spend?groupBy=service&${q}`)).groups.map((g: any) => g.key)).toEqual(["Amazon EC2", "Amazon S3", "Amazon RDS"]);
    expect((await app.get(`/api/v1/spend?groupBy=tag:env&${q}`)).groups.map((g: any) => [g.key, g.amount])).toEqual([
      ["prod", 1540],
      ["untagged", 70],
    ]);
    expect((await app.get(`/api/v1/spend?groupBy=day&${q}`)).groups).toHaveLength(14);
    const weeks = (await app.get(`/api/v1/spend?groupBy=week&${q}`)).groups.map((g: any) => g.key);
    expect(weeks).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect((await app.get(`/api/v1/spend?groupBy=month&from=2026-09-01&to=2026-10-14`)).groups.map((g: any) => g.key)).toEqual(["2026-09", "2026-10"]);
    expect((await app.get(`/api/v1/spend?groupBy=service&service=Amazon%20S3&${q}`)).total).toBe(140);
    expect((await app.get(`/api/v1/spend?groupBy=service&team=untagged&${q}`)).total).toBe(0);
    expect((await app.get(`/api/v1/spend?groupBy=service&tag.team=platform&${q}`)).total).toBe(1400);
    expect((await app.get(`/api/v1/spend?groupBy=account&provider=aws&${q}`)).groups).toHaveLength(3);
    for (const bad of ["groupBy=colour", "from=soon", "provider=oracle", "from=2026-10-10&to=2026-10-01", "groupBy=tag:"])
      expect((await app.admin(`/api/v1/spend?${bad}`)).status, bad).toBe(422);
  });

  it("shows what moved against the same length of time before", async () => {
    await app.send(
      lines(
        ...days("2025-12-01", 7, 100, { account: "666", service: "Amazon Athena" }),
        ...days("2025-12-08", 7, 150, { account: "666", service: "Amazon Athena" }),
      ),
    );
    const r = await app.get("/api/v1/spend/movers?groupBy=service&from=2025-12-08&to=2025-12-14");
    expect(r.previousPeriod).toEqual({ from: "2025-12-01", to: "2025-12-07" });
    expect(r.movers[0]).toEqual({ key: "Amazon Athena", current: 1050, previous: 700, change: 350, changePercent: 50 });
    expect((await app.admin("/api/v1/spend/movers?groupBy=day")).status).toBe(422);
  });
});

describe("currencies", () => {
  it("leaves out spend in a currency nobody has priced, and says so, until a rate is set", async () => {
    await app.send(lines({ date: "2026-05-10", account: "777", service: "Azure VMs", provider: "azure", amount: 10, currency: "EUR" }));
    const before = await app.get("/api/v1/spend?groupBy=provider&provider=azure&from=2026-05-10&to=2026-05-10");
    expect(before).toMatchObject({ total: 0, missingRates: ["EUR"] });
    expect((await put("/api/v1/rates/EUR", { rate: 1.1 })).status).toBe(200);
    expect(await app.get("/api/v1/spend?groupBy=provider&provider=azure&from=2026-05-10&to=2026-05-10")).toMatchObject({ total: 11, missingRates: [] });
    expect((await app.get("/api/v1/rates")).rates).toEqual([{ currency: "EUR", rate: 1.1 }]);
  });

  it("moves the reporting currency, and forgets the rate of the one it moves to", async () => {
    expect((await put("/api/v1/rates/USD", { rate: 2 })).status).toBe(422);
    expect((await put("/api/v1/rates/EUR", { rate: 0 })).status).toBe(422);
    expect((await put("/api/v1/rates/euro", { rate: 1 })).status).toBe(422);
    expect((await put("/api/v1/settings", { currency: "EUR" })).status).toBe(200);
    expect((await app.get("/api/v1/rates")).rates).toEqual([]);
    expect(await app.get("/api/v1/spend?groupBy=provider&provider=azure&from=2026-05-10&to=2026-05-10")).toMatchObject({ currency: "EUR", total: 10 });
    await put("/api/v1/settings", { currency: "USD" });
    expect((await app.admin("/api/v1/rates/EUR", { method: "DELETE" })).status).toBe(404);
    await put("/api/v1/rates/EUR", { rate: 1.1 });
    expect((await app.admin("/api/v1/rates/EUR", { method: "DELETE" })).status).toBe(204);
  });
});

describe("budgets and forecast", () => {
  it("forecasts the month from the last seven days, and shows how the budget is doing", async () => {
    const f = await app.get("/api/v1/summary?asOf=2026-10-14");
    // 1610 so far, 115 a day over the last seven, 17 days left in October.
    expect(f).toMatchObject({ currency: "USD", asOf: "2026-10-14", monthToDate: 1610, dailyRunRate: 115, forecast: 3565, untaggedShare: 0 });
    const created = await post("/api/v1/budgets", { name: "Platform", scope: "team", value: "platform", amount: 3000 });
    expect(created.status).toBe(201);
    const b = (await app.get("/api/v1/budgets?asOf=2026-10-14")).budgets[0];
    expect(b).toMatchObject({
      name: "Platform",
      amount: 3000,
      spent: 1400,
      percent: 46.7,
      forecast: 3100,
      forecastPercent: 103.3,
      burnRate: 1.03,
      reached: null,
      state: "ok",
      month: "2026-10",
    });
    await post("/api/v1/budgets", { name: "Prod tag", scope: "tag", tagKey: "env", value: "prod", amount: 1500 });
    const prod = (await app.get("/api/v1/budgets?asOf=2026-10-14")).budgets.find((x: any) => x.name === "Prod tag");
    expect(prod).toMatchObject({ spent: 1540, percent: 102.7, reached: 100, state: "over" });
    await post("/api/v1/budgets", { name: "Data", scope: "team", value: "data", amount: 200 });
    expect((await app.get("/api/v1/budgets?asOf=2026-10-14")).budgets.find((x: any) => x.name === "Data")).toMatchObject({
      spent: 140,
      percent: 70,
      reached: 50,
      state: "warning",
    });
    await post("/api/v1/budgets", { name: "Databases", scope: "team", value: "databases", amount: 80 });
    expect((await app.get("/api/v1/budgets?asOf=2026-10-14")).budgets.find((x: any) => x.name === "Databases")).toMatchObject({
      percent: 87.5,
      reached: 80,
      state: "alert",
    });
  });

  it("refuses budgets it cannot use", async () => {
    for (const bad of [
      { name: "", scope: "team", value: "x", amount: 1 },
      { name: "A", scope: "region", value: "x", amount: 1 },
      { name: "A", scope: "team", value: "x", amount: 0 },
      { name: "A", scope: "tag", value: "x", amount: 1 },
      { name: "A", scope: "team", value: "x", amount: 1, tagKey: "env" },
      { name: "A", scope: "team", value: "x", amount: 1, colour: "red" },
    ])
      expect((await post("/api/v1/budgets", bad)).status, JSON.stringify(bad)).toBe(422);
    expect((await post("/api/v1/budgets", { name: "Platform", scope: "team", value: "platform", amount: 5 })).status).toBe(409);
    expect((await app.admin("/api/v1/budgets?asOf=tomorrow")).status).toBe(422);
  });

  it("deletes a budget", async () => {
    const id = (await app.get("/api/v1/budgets")).budgets.find((b: any) => b.name === "Databases").id;
    expect((await app.admin(`/api/v1/budgets/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.admin(`/api/v1/budgets/${id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("anomalies", () => {
  it("flags a day far above the 14 before it, and not a small rise", async () => {
    await app.send(lines({ date: "2026-10-15", amount: 130 })); // +30, under the minimum of 50
    expect((await app.get("/api/v1/anomalies")).anomalies).toEqual([]);
    const sent = (await (await app.send(lines({ date: "2026-10-16", amount: 400 }))).json()) as { anomaliesOpen: number };
    expect(sent.anomaliesOpen).toBe(1);
    const a = (await app.get("/api/v1/anomalies")).anomalies[0];
    expect(a).toMatchObject({ date: "2026-10-16", account: "111", service: "Amazon EC2", amount: 400, status: "new", currency: "USD" });
    // The 14 days before 16 October are 14 x 100, except the 15th at 130; so the usual is a little above 100.
    expect(a.usual).toBeGreaterThan(100);
    expect(a.usual).toBeLessThan(103);
  });

  it("does not guess with too little history", async () => {
    await app.send(
      lines(...days("2026-10-01", 3, 10, { account: "888", service: "New" }), { date: "2026-10-04", account: "888", service: "New", amount: 5000 }),
    );
    expect((await app.get("/api/v1/anomalies")).anomalies.filter((x: any) => x.account === "888")).toEqual([]);
  });

  it("lets a smaller minimum catch smaller rises", async () => {
    const tiny = { account: "999", service: "Tiny" };
    await app.send(lines(...days("2026-10-01", 14, 10, tiny), { date: "2026-10-15", amount: 45, ...tiny }));
    const find = async () => (await app.get("/api/v1/anomalies")).anomalies.filter((x: any) => x.account === "999");
    expect(await find()).toEqual([]); // 35 more than usual, under the minimum of 50
    expect((await put("/api/v1/settings", { anomalyMinimum: 10 })).status).toBe(200);
    await app.send(lines({ date: "2026-10-15", amount: 45, ...tiny }));
    expect((await find()).map((x: any) => x.date)).toEqual(["2026-10-15"]);
    expect((await put("/api/v1/settings", { anomalyMinimum: -1 })).status).toBe(422);
    await put("/api/v1/settings", { anomalyMinimum: 50 });
  });

  it("is decided on: acknowledged, or expected with a reason", async () => {
    const a = (await app.get("/api/v1/anomalies")).anomalies.find((x: any) => x.service === "Amazon EC2");
    expect((await put(`/api/v1/anomalies/${a.id}`, { status: "expected" })).status).toBe(422);
    expect((await put(`/api/v1/anomalies/${a.id}`, { status: "gone" })).status).toBe(422);
    expect(await (await put(`/api/v1/anomalies/${a.id}`, { status: "expected", reason: "Load test for the launch" })).json()).toMatchObject({
      status: "expected",
      reason: "Load test for the launch",
      decidedBy: "admin token",
    });
    expect((await app.get("/api/v1/anomalies?status=expected")).anomalies).toHaveLength(1);
    expect((await app.get("/api/v1/anomalies?status=new")).anomalies.map((x: any) => x.service)).toEqual(["Tiny"]);
    expect((await put(`/api/v1/anomalies/${a.id}`, { status: "new" })).status).toBe(200);
    expect((await put("/api/v1/anomalies/missing", { status: "acknowledged" })).status).toBe(404);
    expect((await app.admin("/api/v1/anomalies?status=old")).status).toBe(422);
  });

  it("goes when the day is sent again without the spike", async () => {
    await app.send(lines({ date: "2026-10-16", amount: 100 }));
    expect((await app.get("/api/v1/anomalies")).anomalies.map((x: any) => x.date)).not.toContain("2026-10-16");
  });
});

describe("access", () => {
  it("lets the ingest token send spend and nothing else", async () => {
    expect((await app.ingest("/api/v1/spend")).status).toBe(401);
    expect((await app.ingest("/api/v1/budgets", { method: "POST", body: "{}" })).status).toBe(401);
    const anon = (path: string, init: RequestInit = {}) => fetch(app.base + path, init);
    expect((await anon("/api/v1/records", { method: "POST", body: "[]" })).status).toBe(401);
    expect((await anon("/api/v1/spend")).status).toBe(401);
    expect((await anon("/api/v1/rules", { method: "PUT", body: "{}" })).status).toBe(401);
    const closed = await startApp({ version: "0.1.0", ingestToken: undefined, adminToken: undefined });
    expect((await fetch(`${closed.base}/api/v1/records`, { method: "POST", body: "[]" })).status).toBe(503);
    await closed.close();
  });

  it("answers version, health and metrics", async () => {
    expect(await (await fetch(`${app.base}/api/v1/version`)).json()).toEqual({ product: "cost", version: "0.1.0" });
    expect((await fetch(`${app.base}/readyz`)).status).toBe(200);
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="cost",version="0.1.0"} 1');
    expect(metrics).toMatch(/openasy_cost_month_to_date\{team="platform",currency="USD"\} [\d.]+/);
    expect(metrics).toMatch(/openasy_cost_budget_percent\{budget="Platform"\}/);
    expect(metrics).toMatch(/openasy_cost_anomalies_open \d+/);
  });
});
