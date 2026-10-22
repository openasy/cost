// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  currency: string;
  /** Spend so far this month by team, in the reporting currency. */
  monthToDate: Record<string, number>;
  budgets: Array<{ name: string; percent: number; burnRate: number }>;
  anomaliesOpen: number;
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="cost",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_cost_month_to_date Spend so far this month by team, in the reporting currency.",
    "# TYPE openasy_cost_month_to_date gauge",
    ...Object.entries(g.monthToDate).map(([team, v]) => `openasy_cost_month_to_date{team="${esc(team)}",currency="${g.currency}"} ${v}`),
    "# HELP openasy_cost_budget_percent Share of a monthly budget spent so far.",
    "# TYPE openasy_cost_budget_percent gauge",
    ...g.budgets.map((b) => `openasy_cost_budget_percent{budget="${esc(b.name)}"} ${b.percent}`),
    "# HELP openasy_cost_budget_burn_rate Spend against the straight line to the budget; above 1 runs out early.",
    "# TYPE openasy_cost_budget_burn_rate gauge",
    ...g.budgets.map((b) => `openasy_cost_budget_burn_rate{budget="${esc(b.name)}"} ${b.burnRate}`),
    "# HELP openasy_cost_anomalies_open Anomalies nobody has looked at.",
    "# TYPE openasy_cost_anomalies_open gauge",
    `openasy_cost_anomalies_open ${g.anomaliesOpen}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
