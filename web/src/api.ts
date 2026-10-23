// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type Provider = "aws" | "gcp" | "azure" | "other";
export type BudgetState = "ok" | "warning" | "alert" | "over";
export type AnomalyStatus = "new" | "acknowledged" | "expected";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Summary {
  currency: string;
  asOf: string;
  month: string;
  hasData: boolean;
  monthToDate: number;
  forecast: number;
  dailyRunRate: number;
  previousMonth: number;
  topTeams: Array<{ key: string; amount: number }>;
  topServices: Array<{ key: string; amount: number }>;
  untaggedShare: number;
  anomaliesOpen: number;
  budgetsAtRisk: number;
  missingRates: string[];
}

export interface Group {
  key: string;
  amount: number;
  share: number;
}

export interface Spend {
  currency: string;
  from: string;
  to: string;
  groupBy: string;
  total: number;
  untagged: { amount: number; share: number } | null;
  groups: Group[];
  missingRates: string[];
}

export interface Movers {
  currency: string;
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  groupBy: string;
  movers: Array<{ key: string; current: number; previous: number; change: number; changePercent: number | null }>;
  missingRates: string[];
}

export interface Settings {
  currency: string;
  anomalyMinimum: number;
}

export interface Rate {
  currency: string;
  rate: number;
}

export interface Rule {
  kind: "account" | "service" | "tag";
  match: string;
  tagKey: string | null;
  team: string;
}

export interface Budget {
  id: string;
  name: string;
  scope: "team" | "tag";
  tagKey: string | null;
  value: string;
  amount: number;
  month: string;
  asOf: string;
  spent: number;
  percent: number;
  burnRate: number;
  forecast: number;
  forecastPercent: number;
  thresholds: number[];
  reached: 50 | 80 | 100 | null;
  state: BudgetState;
  currency: string;
}

export interface Anomaly {
  id: string;
  date: string;
  account: string;
  service: string;
  amount: number;
  usual: number;
  deviation: number;
  extra: number;
  status: AnomalyStatus;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  currency: string;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
