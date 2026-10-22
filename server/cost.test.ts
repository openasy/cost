import { describe, expect, it } from "vitest";
import { addDays, amountOf, createCost, resolveTeam, type Rule } from "./cost.ts";
import { openDb } from "./db.ts";
import { parseRecords } from "./records.ts";
import { days, lines } from "./test-app.ts";

const make = () => {
  const cost = createCost(openDb(":memory:"));
  const send = (body: string, replace = false) => cost.ingest(parseRecords(body, undefined), { replace });
  return { cost, send };
};

describe("money", () => {
  it("adds without the drift of floating point", () => {
    const { cost, send } = make();
    // Ten lines of 0.1 are exactly 1.00, and 0.1 + 0.2 is exactly 0.30.
    send(lines(...days("2026-10-01", 10, 0.1)));
    expect(cost.spend("provider", { from: "2026-10-01", to: "2026-10-10" }).total).toBe(1);
    send(lines({ date: "2026-11-01", amount: 0.1 }, { date: "2026-11-01", amount: 0.2, service: "S3" }));
    expect(cost.spend("provider", { from: "2026-11-01", to: "2026-11-01" }).total).toBe(0.3);
    expect(amountOf(1_005_000)).toBe(1.01);
    expect(amountOf(-2_500_000)).toBe(-2.5);
  });

  it("keeps credits as negative spend", () => {
    const { cost, send } = make();
    send(lines({ date: "2026-10-01", amount: 100 }, { date: "2026-10-01", amount: -30, service: "Credits" }));
    expect(cost.spend("service", { from: "2026-10-01", to: "2026-10-01" }).groups.map((g) => [g.key, g.amount])).toEqual([["Amazon EC2", 100], ["Credits", -30]]);
    expect(cost.spend("provider", { from: "2026-10-01", to: "2026-10-01" }).total).toBe(70);
  });
});

describe("forecast", () => {
  it("is the spend so far plus the last seven days as a daily rate over the days left", () => {
    const { cost, send } = make();
    send(lines(...days("2026-02-01", 20, 10)));
    // February 2026 has 28 days; 200 spent by the 20th, 10 a day, 8 days left.
    expect(cost.summary("2026-02-20")).toMatchObject({ monthToDate: 200, dailyRunRate: 10, forecast: 280 });
  });

  it("uses the rate of the last seven days, not the month's average", () => {
    const { cost, send } = make();
    send(lines(...days("2026-10-01", 10, 10), ...days("2026-10-11", 4, 80)));
    // 100 + 320 = 420 so far; the last seven days are 3 x 10 and 4 x 80 = 350, so 50 a day; 17 days left.
    expect(cost.summary("2026-10-14")).toMatchObject({ monthToDate: 420, dailyRunRate: 50, forecast: 420 + 50 * 17 });
  });

  it("is the spend itself on the last day, and starts from nothing in a new month", () => {
    const { cost, send } = make();
    send(lines(...days("2026-09-24", 7, 10)));
    expect(cost.summary("2026-09-30")).toMatchObject({ monthToDate: 70, forecast: 70, previousMonth: 0 });
    send(lines({ date: "2026-10-01", amount: 10 }));
    expect(cost.summary("2026-10-01")).toMatchObject({ month: "2026-10", monthToDate: 10, previousMonth: 70 });
  });

  it("works without any data", () => {
    const { cost } = make();
    expect(cost.summary()).toMatchObject({ hasData: false, monthToDate: 0, forecast: 0 });
    expect(cost.budgets().budgets).toEqual([]);
  });
});

describe("owners", () => {
  const rules: Rule[] = [
    { kind: "account", match: "111", tagKey: null, team: "a" },
    { kind: "service", match: "Amazon R*", tagKey: null, team: "b" },
    { kind: "tag", match: "web", tagKey: "App", team: "c" },
  ];
  it("lets a team tag win, then the first matching rule, then nobody", () => {
    expect(resolveTeam("111", "S3", { team: "mine" }, rules)).toBe("mine");
    expect(resolveTeam("111", "Amazon RDS", {}, rules)).toBe("a");
    expect(resolveTeam("222", "amazon rds", {}, rules)).toBe("b");
    expect(resolveTeam("222", "S3", { app: "web" }, rules)).toBe("c");
    expect(resolveTeam("222", "S3", { app: "api" }, rules)).toBeNull();
  });
  it("does not read a service pattern as a regular expression", () => {
    expect(resolveTeam("1", "Amazon (S3)", {}, [{ kind: "service", match: "Amazon (S3)", tagKey: null, team: "x" }])).toBe("x");
    expect(resolveTeam("1", "AmazonXS3X", {}, [{ kind: "service", match: "Amazon.S3.", tagKey: null, team: "x" }])).toBeNull();
  });
});

describe("anomalies", () => {
  const history = (cost: ReturnType<typeof make>) => cost.send(lines(...days("2026-10-01", 14, (i) => 100 + (i % 2 === 0 ? 5 : -5))));
  it("flags more than the mean plus three deviations, and only when the rise is big enough", () => {
    const m = make();
    history(m);
    // The 14 days alternate 105 and 95: the mean is 100 and the deviation 5, so 115 is the line, and 150 is 50 above.
    m.send(lines({ date: "2026-10-15", amount: 114 }));
    expect(m.cost.anomalies(null, undefined, 10).items).toEqual([]);
    m.send(lines({ date: "2026-10-16", amount: 160 }));
    expect(m.cost.anomalies(null, undefined, 10).items).toMatchObject([{ date: "2026-10-16", amount: 160, extra: expect.any(Number) }]);
    // 130 is above the line but only 30 above the usual, under the minimum.
    m.send(lines({ date: "2026-10-17", amount: 130 }));
    expect(m.cost.anomalies(null, undefined, 10).items.map((a) => a.date)).toEqual(["2026-10-16"]);
  });

  it("counts a day nobody sent as zero, so a steady service with a short history is not alarming", () => {
    const m = make();
    m.send(lines(...days("2026-10-01", 8, 100)));
    // Only 8 of the 14 days before the 9th have data: the mean is 800/14 = 57 and the deviation 49, so 100 is under the line.
    m.send(lines({ date: "2026-10-09", amount: 100 }));
    expect(m.cost.anomalies(null, undefined, 10).items).toEqual([]);
  });

  it("keeps a decision when the day is sent again with the same spike", () => {
    const m = make();
    history(m);
    m.send(lines({ date: "2026-10-15", amount: 300 }));
    const id = m.cost.anomalies(null, undefined, 10).items[0]!.id;
    m.cost.decideAnomaly(id, { status: "acknowledged" }, "someone");
    m.send(lines({ date: "2026-10-15", amount: 320 }));
    expect(m.cost.anomalies(null, undefined, 10).items).toMatchObject([{ id, amount: 320, status: "acknowledged", decidedBy: "someone" }]);
  });
});

describe("days", () => {
  it("steps over month ends", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});
