import {
  AppShell,
  Badge,
  BarList,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  TimeSeriesChart,
  usePath,
  type Column,
  type ProductId,
  useThemePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { BellRing, ChartColumn, Coins, KeyRound, LayoutDashboard, LogIn, LogOut, Plus, Settings2, SlidersHorizontal, Trash2, UserRound, Users, Wallet, Waypoints } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Anomaly, type AnomalyStatus, type Budget, type BudgetState, type Movers, type ProductLink, type Rate, type Rule, type Settings, type Spend, type Summary } from "./api.ts";

const PAGES = ["spend", "budgets", "anomalies", "rules", "settings", "setup", "account", "members", "signin", "tokens"] as const;
type Route = { page: "overview" | (typeof PAGES)[number] };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page] = path.replace(/^\//, "").split("/");
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

/** Amounts in the reporting currency, without cents once they are large. */
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

/** Spend in a currency nobody priced is left out of every figure; say so wherever figures are shown. */
function MissingRates({ currencies }: { currencies: string[] }) {
  if (!currencies.length) return null;
  return (
    <Callout tone="warning" title={`Spend in ${currencies.join(", ")} is left out`}>
      Nobody has said what {currencies.length === 1 ? "it is" : "they are"} worth in the reporting currency. Add a rate under <a href="/settings">Settings</a>.
    </Callout>
  );
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ call, summary }: { call: Call; summary: Summary }) {
  const [daily, setDaily] = useState<Spend>();
  const [movers, setMovers] = useState<Movers>();
  useEffect(() => {
    // The month so far and the one before it, so the chart shows where the run rate comes from.
    const from = `${summary.month}-01`;
    const start = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 7) + "-01";
    void call<Spend>(`/api/v1/spend?groupBy=day&from=${start}&to=${summary.asOf}`).then(setDaily, () => {});
    void call<Movers>("/api/v1/spend/movers?groupBy=service").then(setMovers, () => {});
  }, [call, summary.month, summary.asOf]);

  const s = summary;
  const c = s.currency;
  const vsLast = s.previousMonth ? (s.forecast - s.previousMonth) / s.previousMonth : null;
  return (
    <>
      <PageHeader title="Overview" description={`${s.month}, up to ${day(s.asOf)} · in ${c}`} />
      <MissingRates currencies={s.missingRates} />
      <KpiGrid minWidth={160}>
        <KpiCard label="This month so far" value={money(s.monthToDate, c)} />
        <KpiCard
          label="Forecast for the month"
          value={money(s.forecast, c)}
          delta={vsLast === null ? undefined : { label: `${vsLast > 0 ? "+" : ""}${percent(vsLast)} on last month`, direction: vsLast > 0 ? "up" : vsLast < 0 ? "down" : "flat", intent: vsLast > 0.05 ? "bad" : "neutral" }}
        />
        <KpiCard label="Per day, last 7 days" value={money(s.dailyRunRate, c)} />
        <KpiCard label="Nobody owns" value={percent(s.untaggedShare)} tone={s.untaggedShare > 0.2 ? "warning" : "success"} href="/rules" />
        <KpiCard label="Open anomalies" value={s.anomaliesOpen} tone={s.anomaliesOpen ? "warning" : "success"} href="/anomalies" />
        <KpiCard label="Budgets at risk" value={s.budgetsAtRisk} tone={s.budgetsAtRisk ? "danger" : "success"} href="/budgets" />
      </KpiGrid>
      {daily && daily.groups.length > 1 && (
        <Panel title="Spend per day">
          <TimeSeriesChart label="Spend per day" series={[{ id: "spend", name: "Spend", data: daily.groups.map((g) => g.amount) }]} labels={daily.groups.map((g) => day(g.key))} format={(v) => money(v, c)} area height={180} />
        </Panel>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Teams this month" description="A team tag on a line names the team; otherwise the rules do.">
          {s.topTeams.length ? <BarList label="Spend by team" items={s.topTeams.map((t) => ({ id: t.key, label: t.key, value: t.amount, href: `/spend?groupBy=service&team=${encodeURIComponent(t.key)}` }))} format={(v) => money(v, c)} /> : <p className="m-0 text-sm text-fg-muted">No spend this month.</p>}
        </Panel>
        <Panel title="Services this month">
          {s.topServices.length ? <BarList label="Spend by service" items={s.topServices.map((t) => ({ id: t.key, label: t.key, value: t.amount }))} format={(v) => money(v, c)} /> : <p className="m-0 text-sm text-fg-muted">No spend this month.</p>}
        </Panel>
      </div>
      {movers && movers.movers.length > 0 && (
        <Panel title="What moved" description={`${day(movers.period.from)} to ${day(movers.period.to)}, against the same number of days before.`} flush>
          <MoversTable movers={movers} />
        </Panel>
      )}
    </>
  );
}

function MoversTable({ movers }: { movers: Movers }) {
  const c = movers.currency;
  type Row = Movers["movers"][number];
  const columns: Column<Row>[] = [
    { id: "key", header: movers.groupBy.replace(/^tag:/, "Tag "), width: "34%", cell: (m) => <span className="cost-wrap font-medium">{m.key}</span> },
    { id: "current", header: "Now", align: "right", cell: (m) => money(m.current, c) },
    { id: "previous", header: "Before", align: "right", cell: (m) => money(m.previous, c) },
    {
      id: "change",
      header: "Change",
      align: "right",
      sortValue: (m) => m.change,
      cell: (m) => (
        <span className={m.change > 0 ? "text-danger" : "text-success"}>
          {m.change > 0 ? "+" : ""}
          {money(m.change, c)}
          {m.changePercent !== null && ` (${m.change > 0 ? "+" : ""}${m.changePercent}%)`}
        </span>
      ),
    },
  ];
  return <DataTable label="What moved" columns={columns} rows={movers.movers} getRowId={(m) => m.key} minWidth={560} />;
}

// ---------------------------------------------------------------- Spend

const GROUPS = [
  { value: "team", label: "Team" },
  { value: "service", label: "Service" },
  { value: "account", label: "Account" },
  { value: "provider", label: "Provider" },
  { value: "region", label: "Region" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];
type Period = "month" | "last-month" | "30" | "90";
const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

function periodOf(period: Period, asOf: string): { from: string; to: string } {
  const at = Date.parse(`${asOf}T00:00:00Z`);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (period === "month") return { from: `${asOf.slice(0, 7)}-01`, to: asOf };
  if (period === "last-month") {
    const end = Date.parse(`${asOf.slice(0, 7)}-01T00:00:00Z`) - 86_400_000;
    return { from: `${iso(end).slice(0, 7)}-01`, to: iso(end) };
  }
  return { from: iso(at - (Number(period) - 1) * 86_400_000), to: asOf };
}

function SpendPage({ call, summary }: { call: Call; summary: Summary }) {
  const params = new URLSearchParams(window.location.search);
  const [groupBy, setGroupBy] = useState(params.get("groupBy") ?? "team");
  const [tagKey, setTagKey] = useState("");
  const [period, setPeriod] = useState<Period>("month");
  const [team, setTeam] = useState(params.get("team") ?? "");
  const [spend, setSpend] = useState<Spend>();
  const [movers, setMovers] = useState<Movers>();
  const [error, setError] = useState<string>();

  const by = groupBy === "tag" ? (tagKey.trim() ? `tag:${tagKey.trim()}` : "") : groupBy;
  useEffect(() => {
    if (!by) return;
    const { from, to } = periodOf(period, summary.asOf);
    const q = new URLSearchParams({ groupBy: by, from, to, ...(team && { team }) });
    setSpend(undefined);
    call<Spend>(`/api/v1/spend?${q}`).then((s) => (setSpend(s), setError(undefined)), (err: Error) => setError(err.message));
    if (!["day", "week", "month"].includes(by)) void call<Movers>(`/api/v1/spend/movers?${q}`).then(setMovers, () => setMovers(undefined));
    else setMovers(undefined);
  }, [call, by, period, team, summary.asOf]);

  const c = summary.currency;
  const isTime = ["day", "week", "month"].includes(by);
  const columns: Column<Spend["groups"][number]>[] = [
    { id: "key", header: GROUPS.find((g) => g.value === groupBy)?.label ?? `Tag ${tagKey}`, width: "40%", sortValue: (g) => g.key, cell: (g) => <span className="cost-wrap font-medium">{isTime ? g.key : g.key || "(none)"}</span> },
    { id: "amount", header: "Spend", align: "right", sortValue: (g) => g.amount, cell: (g) => money(g.amount, c) },
    { id: "share", header: "Share", align: "right", sortValue: (g) => g.share, cell: (g) => percent(g.share) },
  ];
  return (
    <>
      <PageHeader title="Spend" description={spend ? `${money(spend.total, c)} from ${day(spend.from)} to ${day(spend.to)}${team ? ` · team ${team}` : ""}` : undefined} />
      <div className="flex flex-wrap items-end gap-2">
        <SegmentedControl label="Period" value={period} onChange={setPeriod} options={PERIODS} />
        <SelectField label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} options={[...GROUPS, { value: "tag", label: "A tag" }]} />
        {groupBy === "tag" && <TextField label="Tag name" value={tagKey} onChange={(e) => setTagKey(e.target.value)} hint="Such as env." />}
        <TextField label="Team" value={team} onChange={(e) => setTeam(e.target.value)} hint="Empty for all; untagged for spend nobody owns." />
      </div>
      {error && <Callout tone="danger" title="Could not read the spend">{error}</Callout>}
      {spend && <MissingRates currencies={spend.missingRates} />}
      {spend?.untagged && spend.untagged.amount > 0 && (
        <p className="m-0 text-sm text-fg-muted">
          {money(spend.untagged.amount, c)} ({percent(spend.untagged.share)}) has no team yet. Give it one with a team tag, or with <a href="/rules">Rules</a>.
        </p>
      )}
      {spend && isTime && spend.groups.length > 1 && (
        <Panel title="Over time">
          <TimeSeriesChart label="Spend over time" series={[{ id: "spend", name: "Spend", data: spend.groups.map((g) => g.amount) }]} labels={spend.groups.map((g) => g.key)} format={(v) => money(v, c)} area height={180} />
        </Panel>
      )}
      <Panel flush>
        <DataTable label="Spend" columns={columns} rows={spend?.groups ?? []} loading={!spend && !error && !!by} getRowId={(g) => g.key} minWidth={520} pageSize={50} empty={<EmptyState title="No spend">Nothing was spent in this period{team ? " by this team" : ""}.</EmptyState>} />
      </Panel>
      {movers && movers.movers.length > 0 && (
        <Panel title="What moved" description={`Against ${day(movers.previousPeriod.from)} to ${day(movers.previousPeriod.to)}.`} flush>
          <MoversTable movers={movers} />
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Budgets

const BUDGET_LABEL: Record<BudgetState, string> = { ok: "On track", warning: "Past 50%", alert: "Past 80%", over: "Over" };
const BUDGET_TONE: Record<BudgetState, "success" | "info" | "warning" | "danger"> = { ok: "success", warning: "info", alert: "warning", over: "danger" };

function BudgetDialog({ call, currency, onClose, onSaved }: { call: Call; currency: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"team" | "tag">("team");
  const [tagKey, setTagKey] = useState("");
  const [value, setValue] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/budgets", { method: "POST", body: JSON.stringify({ name, scope, value, amount: Number(amount), ...(scope === "tag" && { tagKey }) }) });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a budget"
      description="A monthly amount for a team or for a tag value. Its alerts are at 50%, 80% and 100%, and the forecast says where the month ends."
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !value.trim() || !(Number(amount) > 0) || (scope === "tag" && !tagKey.trim())}>
            Add budget
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <SelectField
        label="For"
        value={scope}
        onChange={(e) => setScope(e.target.value as "team" | "tag")}
        options={[
          { value: "team", label: "A team" },
          { value: "tag", label: "A tag value" },
        ]}
      />
      <div className="grid grid-cols-2 gap-2">
        {scope === "tag" && <TextField label="Tag name" value={tagKey} onChange={(e) => setTagKey(e.target.value)} hint="Such as env." />}
        <TextField label={scope === "team" ? "Team" : "Tag value"} value={value} onChange={(e) => setValue(e.target.value)} hint={scope === "tag" ? "Such as prod." : undefined} />
      </div>
      <TextField label={`Each month (${currency})`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={error} />
    </Dialog>
  );
}

function BudgetsPage({ call, summary, reload }: { call: Call; summary: Summary; reload: () => void }) {
  const { can } = useAuth();
  const [budgets, setBudgets] = useState<Budget[]>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Budget>();
  const load = useCallback(() => void call<{ budgets: Budget[] }>("/api/v1/budgets").then((r) => setBudgets(r.budgets), () => setBudgets([])), [call]);
  useEffect(load, [load]);

  const c = summary.currency;
  const columns: Column<Budget>[] = [
    { id: "state", header: "State", width: "110px", cell: (b) => <StatusBadge tone={BUDGET_TONE[b.state]}>{BUDGET_LABEL[b.state]}</StatusBadge> },
    {
      id: "name",
      header: "Budget",
      width: "26%",
      sortValue: (b) => b.name,
      cell: (b) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{b.name}</span>
          <span className="text-xs text-fg-muted">{b.scope === "team" ? `Team ${b.value}` : `${b.tagKey} = ${b.value}`}</span>
        </span>
      ),
    },
    { id: "spent", header: "Spent", align: "right", sortValue: (b) => b.percent, cell: (b) => `${money(b.spent, c)} (${b.percent}%)` },
    { id: "amount", header: "Budget", align: "right", cell: (b) => money(b.amount, c) },
    { id: "forecast", header: "Forecast", align: "right", sortValue: (b) => b.forecastPercent, cell: (b) => <span className={b.forecastPercent >= 100 ? "text-danger" : undefined}>{`${money(b.forecast, c)} (${b.forecastPercent}%)`}</span> },
    { id: "burn", header: "Burn rate", align: "right", sortValue: (b) => b.burnRate, cell: (b) => <span className={b.burnRate > 1 ? "text-warning" : undefined}>{b.burnRate.toFixed(2)}</span> },
    ...(can("admin") ? [{ id: "remove", header: "", align: "right" as const, width: "56px", cell: (b: Budget) => <Button size="sm" icon={<Trash2 />} aria-label={`Delete ${b.name}`} onClick={() => setRemoving(b)} /> }] : []),
  ];
  return (
    <>
      <PageHeader
        title="Budgets"
        description={`${summary.month}. A burn rate above 1 means the budget runs out before the month does.`}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add budget
            </Button>
          )
        }
      />
      <MissingRates currencies={summary.missingRates} />
      <Panel flush>
        <DataTable label="Budgets" columns={columns} rows={budgets ?? []} loading={!budgets} getRowId={(b) => b.id} minWidth={860} empty={<EmptyState title="No budgets yet">{can("admin") ? "Add a monthly budget for a team or a tag." : "An admin adds the budgets."}</EmptyState>} />
      </Panel>
      <p className="m-0 text-xs text-fg-muted">The forecast is the spend so far plus the last seven days' rate for the days left. /metrics has each budget's share and burn rate, to alert on.</p>
      {adding && (
        <BudgetDialog
          call={call}
          currency={c}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
            reload();
          }}
        />
      )}
      {removing && (
        <Dialog
          open
          onOpenChange={(o) => !o && setRemoving(undefined)}
          title={`Delete ${removing.name}?`}
          description="The spend stays; only the budget goes."
          footer={
            <>
              <Button type="button" onClick={() => setRemoving(undefined)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() =>
                  void call(`/api/v1/budgets/${removing.id}`, { method: "DELETE" }).then(() => {
                    setRemoving(undefined);
                    load();
                    reload();
                  })
                }
              >
                Delete
              </Button>
            </>
          }
        >
          <></>
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Anomalies

const ANOMALY_LABEL: Record<AnomalyStatus, string> = { new: "New", acknowledged: "Acknowledged", expected: "Expected" };
const ANOMALY_TONE: Record<AnomalyStatus, "warning" | "neutral" | "info"> = { new: "warning", acknowledged: "neutral", expected: "info" };

function DecideDialog({ anomaly, call, onClose, onSaved }: { anomaly: Anomaly; call: Call; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<AnomalyStatus>(anomaly.status === "new" ? "acknowledged" : anomaly.status);
  const [reason, setReason] = useState(anomaly.reason ?? "");
  const [error, setError] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call(`/api/v1/anomalies/${anomaly.id}`, { method: "PUT", body: JSON.stringify({ status, ...(reason.trim() && status !== "new" && { reason }) }) });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${anomaly.service} on ${day(anomaly.date)}`}
      description={`${money(anomaly.amount, anomaly.currency)} against a usual ${money(anomaly.usual, anomaly.currency)}, in account ${anomaly.account}.`}
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={status === "expected" && reason.trim().length < 3}>
            Save
          </Button>
        </>
      }
    >
      <SelectField
        label="What it is"
        value={status}
        onChange={(e) => setStatus(e.target.value as AnomalyStatus)}
        options={[
          { value: "acknowledged", label: "Acknowledged: someone is looking" },
          { value: "expected", label: "Expected: we knew, and why" },
          { value: "new", label: "New: nobody has looked" },
        ]}
      />
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint={status === "expected" ? "Required: a load test, a migration, a new customer." : "Optional."} error={error} />
    </Dialog>
  );
}

function AnomaliesPage({ call, summary, reload }: { call: Call; summary: Summary; reload: () => void }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<AnomalyStatus>("new");
  const [rows, setRows] = useState<Anomaly[]>();
  const [deciding, setDeciding] = useState<Anomaly>();
  const load = useCallback(() => {
    setRows(undefined);
    void call<{ anomalies: Anomaly[] }>(`/api/v1/anomalies?status=${tab}&limit=500`).then((r) => setRows(r.anomalies), () => setRows([]));
  }, [call, tab]);
  useEffect(load, [load]);

  const columns: Column<Anomaly>[] = [
    { id: "date", header: "Day", width: "90px", sortValue: (a) => a.date, cell: (a) => <span className="whitespace-nowrap text-xs">{day(a.date)}</span> },
    {
      id: "service",
      header: "Service",
      width: "30%",
      cell: (a) => (
        <span className="flex min-w-0 flex-col">
          <span className="cost-wrap font-medium">{a.service}</span>
          <span className="text-xs text-fg-muted">Account {a.account}</span>
        </span>
      ),
    },
    { id: "amount", header: "Cost", align: "right", cell: (a) => money(a.amount, a.currency) },
    { id: "usual", header: "Usual", align: "right", cell: (a) => money(a.usual, a.currency) },
    { id: "extra", header: "More", align: "right", sortValue: (a) => a.extra, cell: (a) => <span className="text-danger">+{money(a.extra, a.currency)}</span> },
    { id: "status", header: "Status", cell: (a) => <StatusBadge tone={ANOMALY_TONE[a.status]}>{ANOMALY_LABEL[a.status]}</StatusBadge> },
    { id: "reason", header: "Reason", width: "22%", cell: (a) => <span className="cost-clamp text-xs text-fg-muted" title={a.reason ?? undefined}>{a.reason ?? ""}{a.decidedBy ? ` (${a.decidedBy})` : ""}</span> },
    ...(can("editor") ? [{ id: "decide", header: "", align: "right" as const, width: "90px", cell: (a: Anomaly) => <Button size="sm" onClick={() => setDeciding(a)}>Decide</Button> }] : []),
  ];
  return (
    <>
      <PageHeader title="Anomalies" description="A day of one service in one account that cost more than the mean of the 14 days before it plus three standard deviations, and by more than the minimum under Settings." />
      <SegmentedControl
        label="Status"
        value={tab}
        onChange={setTab}
        options={[
          { value: "new", label: `New${summary.anomaliesOpen ? ` (${summary.anomaliesOpen})` : ""}` },
          { value: "acknowledged", label: "Acknowledged" },
          { value: "expected", label: "Expected" },
        ]}
      />
      <Panel flush>
        <DataTable label="Anomalies" columns={columns} rows={rows ?? []} loading={!rows} getRowId={(a) => a.id} minWidth={900} pageSize={50} empty={<EmptyState title={tab === "new" ? "Nothing unusual" : "None"}>{tab === "new" ? "No day has cost far more than usual." : "Nothing has been decided this way."}</EmptyState>} />
      </Panel>
      {deciding && (
        <DecideDialog
          anomaly={deciding}
          call={call}
          onClose={() => setDeciding(undefined)}
          onSaved={() => {
            setDeciding(undefined);
            load();
            reload();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Rules

type DraftRule = { kind: Rule["kind"]; match: string; tagKey: string; team: string };

function RulesPage({ call, reload }: { call: Call; reload: () => void }) {
  const { can } = useAuth();
  const admin = can("admin");
  const [rules, setRules] = useState<DraftRule[]>();
  const [saved, setSaved] = useState<string>("");
  const [error, setError] = useState<string>();
  const load = useCallback(
    () =>
      void call<{ rules: Rule[] }>("/api/v1/rules").then(
        (r) => {
          const draft = r.rules.map((x) => ({ kind: x.kind, match: x.match, tagKey: x.tagKey ?? "", team: x.team }));
          setRules(draft);
          setSaved(JSON.stringify(draft));
        },
        () => setRules([]),
      ),
    [call],
  );
  useEffect(load, [load]);

  const change = (i: number, patch: Partial<DraftRule>) => setRules((rs) => rs?.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    try {
      await call("/api/v1/rules", { method: "PUT", body: JSON.stringify({ rules: (rules ?? []).map((r) => ({ kind: r.kind, match: r.match, team: r.team, ...(r.kind === "tag" && { tagKey: r.tagKey }) })) }) });
      setError(undefined);
      load();
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <PageHeader title="Rules" description="Who owns spend that has no team tag. A team tag on a line wins over every rule; then the first rule that matches." />
      <Panel title="In order" description="Service names take * and ? as wildcards; case does not matter.">
        {!rules ? null : !rules.length && !admin ? (
          <p className="m-0 text-sm text-fg-muted">No rules: spend without a team tag belongs to nobody.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {rules.map((r, i) => (
              <div key={i} className="cost-rule flex flex-wrap items-end gap-2">
                <SelectField
                  label="When"
                  value={r.kind}
                  disabled={!admin}
                  onChange={(e) => change(i, { kind: e.target.value as Rule["kind"] })}
                  options={[
                    { value: "account", label: "Account is" },
                    { value: "service", label: "Service is" },
                    { value: "tag", label: "Tag is" },
                  ]}
                />
                {r.kind === "tag" && <TextField label="Tag name" value={r.tagKey} disabled={!admin} onChange={(e) => change(i, { tagKey: e.target.value })} />}
                <TextField label={r.kind === "account" ? "Account id" : r.kind === "service" ? "Service" : "Tag value"} value={r.match} disabled={!admin} onChange={(e) => change(i, { match: e.target.value })} />
                <TextField label="Team" value={r.team} disabled={!admin} onChange={(e) => change(i, { team: e.target.value })} />
                {admin && <Button icon={<Trash2 />} aria-label="Remove rule" onClick={() => setRules((rs) => rs?.filter((_, j) => j !== i))} />}
              </div>
            ))}
            {admin && (
              <div className="flex flex-wrap items-center gap-2">
                <Button icon={<Plus />} onClick={() => setRules((rs) => [...(rs ?? []), { kind: "account", match: "", tagKey: "", team: "" }])}>
                  Add rule
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={JSON.stringify(rules) === saved}>
                  Save rules
                </Button>
                {error && <span className="text-xs text-danger">{error}</span>}
              </div>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Settings and setup

function CostSettingsPage({ call, reload }: { call: Call; reload: () => void }) {
  const { can } = useAuth();
  const admin = can("admin");
  const [settings, setSettings] = useState<Settings>();
  const [currency, setCurrency] = useState("");
  const [minimum, setMinimum] = useState("");
  const [rates, setRates] = useState<Rate[]>();
  const [rateCurrency, setRateCurrency] = useState("");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string>();
  const [rateError, setRateError] = useState<string>();

  const loadRates = useCallback(() => void call<{ rates: Rate[] }>("/api/v1/rates").then((r) => setRates(r.rates), () => setRates([])), [call]);
  useEffect(() => {
    void call<Settings>("/api/v1/settings").then((s) => (setSettings(s), setCurrency(s.currency), setMinimum(String(s.anomalyMinimum))), () => {});
    loadRates();
  }, [call, loadRates]);

  const put = async () => {
    try {
      const s = await call<Settings>("/api/v1/settings", { method: "PUT", body: JSON.stringify({ currency: currency.trim().toUpperCase(), anomalyMinimum: Number(minimum) }) });
      setSettings(s);
      setError(undefined);
      loadRates();
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const putRate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call(`/api/v1/rates/${rateCurrency.trim().toUpperCase()}`, { method: "PUT", body: JSON.stringify({ rate: Number(rate) }) });
      setRateCurrency("");
      setRate("");
      setRateError(undefined);
      loadRates();
      reload();
    } catch (err) {
      setRateError((err as Error).message);
    }
  };
  const columns: Column<Rate>[] = [
    { id: "currency", header: "Currency", cell: (r) => <Badge>{r.currency}</Badge> },
    { id: "rate", header: settings ? `One unit in ${settings.currency}` : "Rate", align: "right", cell: (r) => r.rate },
    ...(admin
      ? [
          {
            id: "remove",
            header: "",
            align: "right" as const,
            width: "56px",
            cell: (r: Rate) => <Button size="sm" icon={<Trash2 />} aria-label={`Delete the rate of ${r.currency}`} onClick={() => void call(`/api/v1/rates/${r.currency}`, { method: "DELETE" }).then(() => (loadRates(), reload()))} />,
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader title="Settings" description="The currency figures are shown in, what other currencies are worth, and how large a rise must be to be an anomaly." />
      {settings && (
        <Panel title="Reporting">
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField label="Reporting currency" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!admin} hint="A three-letter code, such as USD or EUR." />
            <TextField label={`An anomaly is at least this much more than usual (${settings.currency})`} inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value)} disabled={!admin} error={error} />
          </div>
          {admin && (
            <div className="mt-3">
              <Button variant="primary" onClick={() => void put()} disabled={currency.trim().toUpperCase() === settings.currency && Number(minimum) === settings.anomalyMinimum}>
                Save
              </Button>
            </div>
          )}
        </Panel>
      )}
      <Panel title="Rates" description="Spend in a currency without a rate is left out of every figure, and each page says so. Rates are fixed until you change them; nothing is fetched." flush>
        <DataTable label="Rates" columns={columns} rows={rates ?? []} loading={!rates} getRowId={(r) => r.currency} minWidth={360} empty={<EmptyState title="No rates">All spend is in the reporting currency, or none has been sent yet.</EmptyState>} />
      </Panel>
      {admin && (
        <Panel title="Set a rate" description="A rate for a currency that has one replaces it.">
          <form className="flex flex-col gap-2" onSubmit={putRate}>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField label="Currency" value={rateCurrency} onChange={(e) => setRateCurrency(e.target.value)} placeholder="EUR" />
              <TextField label={settings ? `One unit in ${settings.currency}` : "Rate"} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="1.08" error={rateError} />
            </div>
            <div>
              <Button type="submit" variant="primary" disabled={!/^[A-Za-z]{3}$/.test(rateCurrency.trim()) || !(Number(rate) > 0)}>
                Set rate
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}

function SetupPage() {
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title="Setup" description="A pipeline sends the bill, once a day or as often as the provider updates it. Cost reads it; it holds no cloud credentials." />
      <Panel title="AWS" description="Cost Explorer's answer, turned into spend lines by tools/ce-to-records.mjs from the repository. Use COST_INGEST_TOKEN, set where cost runs, or an API token with the editor role.">
        <Code>{`aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-22 --granularity DAILY \\
  --metrics UnblendedCost \\
  --group-by Type=DIMENSION,Key=LINKED_ACCOUNT Type=DIMENSION,Key=SERVICE Type=TAG,Key=team \\
  | node tools/ce-to-records.mjs \\
  | curl -sf -X POST -H "Authorization: Bearer $COST_INGEST_TOKEN" -H 'content-type: application/json' \\
    --data-binary @- "${origin}/api/v1/records?replace=true"`}</Code>
      </Panel>
      <Panel title="Anything else" description="JSON, NDJSON or CSV, optionally gzipped. In CSV, tags are columns named tag:team.">
        <Code>{`curl -sf -X POST -H "Authorization: Bearer $COST_INGEST_TOKEN" -H 'content-type: text/csv' \\
  --data-binary @spend.csv "${origin}/api/v1/records"

date,provider,account,service,amount,currency,tag:team
2026-10-21,gcp,my-project,Compute Engine,412.30,USD,payments`}</Code>
      </Panel>
      <Panel title="What to know">
        <ul className="cost-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>A day sent again replaces what was there, so a daily job can send the whole month. With replace=true, lines the new export no longer has go too.</li>
          <li>A team tag names the owner. Spend without one goes to the first rule that matches, or to nobody.</li>
          <li>Credits are negative amounts. Spend in another currency counts once it has a rate under Settings.</li>
          <li>/metrics has month-to-date by team, each budget's share and burn rate, and open anomalies, for Prometheus.</li>
        </ul>
      </Panel>
    </>
  );
}

/** The first screen, until spend arrives. The summary is polled, so it gives way by itself. */
function WelcomePage() {
  return (
    <>
      <PageHeader title="Get started" description="Send the first day of spend." actions={<StatusBadge tone="info">Waiting for spend</StatusBadge>} />
      <SetupPage />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title="Admins only">Ask an admin of this cost for access.</EmptyState>;
  const titles = {
    account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
    members: ["Members", "Who can sign in to this cost, and with which role. Viewers see everything; editors also send spend and decide on anomalies; admins also change budgets, rules, rates and settings, and manage members and tokens."],
    signin: ["Sign-in", "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role."],
    tokens: ["API tokens", "For scripts and CI. Each token has one role and an expiry; the secret is shown once."],
  } as const;
  return (
    <>
      <PageHeader
        title={titles[page][0]}
        description={titles[page][1]}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              Sign out
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const [theme, setTheme] = useThemePreference();
  const { me, can } = useAuth();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "cost" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "spend", label: "Spend", icon: ChartColumn },
    { id: "budgets", label: "Budgets", icon: Wallet, count: summary?.budgetsAtRisk || undefined },
    { id: "anomalies", label: "Anomalies", icon: BellRing, count: summary?.anomaliesOpen || undefined },
    { id: "rules", label: "Rules", icon: Waypoints },
  ];
  const footerNav = [
    { id: "setup", label: "Setup", icon: Settings2 },
    { id: "settings", label: "Settings", icon: SlidersHorizontal },
    ...(can("admin")
      ? [
          { id: "members", label: "Members", icon: Users },
          { id: "signin", label: "Sign-in", icon: LogIn },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const needsData = route.page === "overview" || route.page === "spend" || route.page === "budgets" || route.page === "anomalies";

  return (
    <AppShell
      product="cost"
      nav={nav}
      activeNav={route.page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
      theme={theme}
      onThemeChange={setTheme}
    >
      {needsData && !summary ? (
        <EmptyState title="Loading" icon={<Coins />}>
          Reading the spend.
        </EmptyState>
      ) : route.page === "overview" && summary && !summary.hasData ? (
        <WelcomePage />
      ) : route.page === "overview" && summary ? (
        <OverviewPage call={call} summary={summary} />
      ) : route.page === "spend" && summary ? (
        <SpendPage call={call} summary={summary} />
      ) : route.page === "budgets" && summary ? (
        <BudgetsPage call={call} summary={summary} reload={reload} />
      ) : route.page === "anomalies" && summary ? (
        <AnomaliesPage call={call} summary={summary} reload={reload} />
      ) : route.page === "rules" ? (
        <RulesPage call={call} reload={reload} />
      ) : route.page === "settings" ? (
        <CostSettingsPage call={call} reload={reload} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <SetupPage />
      )}
    </AppShell>
  );
}

export function App() {
  const [theme] = useThemePreference();
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider theme={theme} brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy Cost">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
