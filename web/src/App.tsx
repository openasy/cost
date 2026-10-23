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
import {
  BellRing,
  ChartColumn,
  Coins,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Plus,
  Settings2,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Users,
  Wallet,
  Waypoints,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type Anomaly,
  type AnomalyStatus,
  type Budget,
  type BudgetState,
  type Movers,
  type ProductLink,
  type Rate,
  type Rule,
  type Settings,
  type Spend,
  type Summary,
} from "./api.ts";
import { useT, type T } from "./i18n.ts";

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
  const t = useT();
  if (!currencies.length) return null;
  return (
    <Callout tone="warning" title={t("missingRates.spendInIsLeftOut", { value: currencies.join(", ") })}>
      {t("missingRates.nobodyHasSaidWhat")} {currencies.length === 1 ? t("missingRates.itIs") : t("missingRates.theyAre")}{" "}
      {t("missingRates.worthInTheReportingCurrency")} <a href="/settings">{t("missingRates.settings")}</a>.
    </Callout>
  );
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ call, summary }: { call: Call; summary: Summary }) {
  const msg = useT();
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
      <PageHeader title={msg("overviewPage.overview")} description={msg("overviewPage.upToIn", { month: s.month, day: day(s.asOf), c })} />
      <MissingRates currencies={s.missingRates} />
      <KpiGrid minWidth={160}>
        <KpiCard label={msg("overviewPage.thisMonthSoFar")} value={money(s.monthToDate, c)} />
        <KpiCard
          label={msg("overviewPage.forecastForTheMonth")}
          value={money(s.forecast, c)}
          delta={
            vsLast === null
              ? undefined
              : {
                  label: msg("overviewPage.onLastMonth", { value: vsLast > 0 ? "+" : "", percent: percent(vsLast) }),
                  direction: vsLast > 0 ? "up" : vsLast < 0 ? "down" : "flat",
                  intent: vsLast > 0.05 ? "bad" : "neutral",
                }
          }
        />
        <KpiCard label={msg("overviewPage.perDayLast7Days")} value={money(s.dailyRunRate, c)} />
        <KpiCard label={msg("overviewPage.nobodyOwns")} value={percent(s.untaggedShare)} tone={s.untaggedShare > 0.2 ? "warning" : "success"} href="/rules" />
        <KpiCard label={msg("overviewPage.openAnomalies")} value={s.anomaliesOpen} tone={s.anomaliesOpen ? "warning" : "success"} href="/anomalies" />
        <KpiCard label={msg("overviewPage.budgetsAtRisk")} value={s.budgetsAtRisk} tone={s.budgetsAtRisk ? "danger" : "success"} href="/budgets" />
      </KpiGrid>
      {daily && daily.groups.length > 1 && (
        <Panel title={msg("overviewPage.spendPerDay")}>
          <TimeSeriesChart
            label={msg("overviewPage.spendPerDay")}
            series={[{ id: "spend", name: "Spend", data: daily.groups.map((g) => g.amount) }]}
            labels={daily.groups.map((g) => day(g.key))}
            format={(v) => money(v, c)}
            area
            height={180}
          />
        </Panel>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={msg("overviewPage.teamsThisMonth")} description={msg("overviewPage.aTeamTagOnA")}>
          {s.topTeams.length ? (
            <BarList
              label={msg("overviewPage.spendByTeam")}
              items={s.topTeams.map((t) => ({ id: t.key, label: t.key, value: t.amount, href: `/spend?groupBy=service&team=${encodeURIComponent(t.key)}` }))}
              format={(v) => money(v, c)}
            />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{msg("overviewPage.noSpendThisMonth")}</p>
          )}
        </Panel>
        <Panel title={msg("overviewPage.servicesThisMonth")}>
          {s.topServices.length ? (
            <BarList
              label={msg("overviewPage.spendByService")}
              items={s.topServices.map((t) => ({ id: t.key, label: t.key, value: t.amount }))}
              format={(v) => money(v, c)}
            />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{msg("overviewPage.noSpendThisMonth")}</p>
          )}
        </Panel>
      </div>
      {movers && movers.movers.length > 0 && (
        <Panel
          title={msg("overviewPage.whatMoved")}
          description={msg("overviewPage.toAgainstTheSameNumber", { day: day(movers.period.from), day2: day(movers.period.to) })}
          flush
        >
          <MoversTable movers={movers} />
        </Panel>
      )}
    </>
  );
}

function MoversTable({ movers }: { movers: Movers }) {
  const t = useT();
  const c = movers.currency;
  type Row = Movers["movers"][number];
  const columns: Column<Row>[] = [
    { id: "key", header: movers.groupBy.replace(/^tag:/, "Tag "), width: "34%", cell: (m) => <span className="cost-wrap font-medium">{m.key}</span> },
    { id: "current", header: t("moversTable.now"), align: "right", cell: (m) => money(m.current, c) },
    { id: "previous", header: t("moversTable.before"), align: "right", cell: (m) => money(m.previous, c) },
    {
      id: "change",
      header: t("moversTable.change"),
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
  return <DataTable label={t("moversTable.whatMoved")} columns={columns} rows={movers.movers} getRowId={(m) => m.key} minWidth={560} />;
}

// ---------------------------------------------------------------- Spend

const GROUPS = (t: T) => [
  { value: "team", label: t("groups.team") },
  { value: "service", label: t("groups.service") },
  { value: "account", label: t("groups.account") },
  { value: "provider", label: t("groups.provider") },
  { value: "region", label: t("groups.region") },
  { value: "day", label: t("groups.day") },
  { value: "week", label: t("groups.week") },
  { value: "month", label: t("groups.month") },
];
type Period = "month" | "last-month" | "30" | "90";
const PERIODS = (t: T): Array<{ value: Period; label: string }> => [
  { value: "month", label: t("periods.thisMonth") },
  { value: "last-month", label: t("periods.lastMonth") },
  { value: "30", label: t("periods.n30Days") },
  { value: "90", label: t("periods.n90Days") },
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
  const t = useT();
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
    call<Spend>(`/api/v1/spend?${q}`).then(
      (s) => (setSpend(s), setError(undefined)),
      (err: Error) => setError(err.message),
    );
    if (!["day", "week", "month"].includes(by)) void call<Movers>(`/api/v1/spend/movers?${q}`).then(setMovers, () => setMovers(undefined));
    else setMovers(undefined);
  }, [call, by, period, team, summary.asOf]);

  const c = summary.currency;
  const isTime = ["day", "week", "month"].includes(by);
  const columns: Column<Spend["groups"][number]>[] = [
    {
      id: "key",
      header: GROUPS(t).find((g) => g.value === groupBy)?.label ?? t("spendPage.tag", { tagKey }),
      width: "40%",
      sortValue: (g) => g.key,
      cell: (g) => <span className="cost-wrap font-medium">{isTime ? g.key : g.key || "(none)"}</span>,
    },
    { id: "amount", header: t("spendPage.spend"), align: "right", sortValue: (g) => g.amount, cell: (g) => money(g.amount, c) },
    { id: "share", header: t("spendPage.share"), align: "right", sortValue: (g) => g.share, cell: (g) => percent(g.share) },
  ];
  return (
    <>
      <PageHeader
        title={t("spendPage.spend")}
        description={
          spend
            ? t("spendPage.fromTo", { money: money(spend.total, c), day: day(spend.from), day2: day(spend.to), value: team ? ` · team ${team}` : "" })
            : undefined
        }
      />
      <div className="flex flex-wrap items-end gap-2">
        <SegmentedControl label={t("spendPage.period")} value={period} onChange={setPeriod} options={PERIODS(t)} />
        <SelectField
          label={t("spendPage.groupBy")}
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          options={[...GROUPS(t), { value: "tag", label: t("spendPage.aTag") }]}
        />
        {groupBy === "tag" && (
          <TextField label={t("spendPage.tagName")} value={tagKey} onChange={(e) => setTagKey(e.target.value)} hint={t("spendPage.suchAsEnv")} />
        )}
        <TextField label={t("spendPage.team")} value={team} onChange={(e) => setTeam(e.target.value)} hint={t("spendPage.emptyForAllUntaggedFor")} />
      </div>
      {error && (
        <Callout tone="danger" title={t("spendPage.couldNotReadTheSpend")}>
          {error}
        </Callout>
      )}
      {spend && <MissingRates currencies={spend.missingRates} />}
      {spend?.untagged && spend.untagged.amount > 0 && (
        <p className="m-0 text-sm text-fg-muted">
          {money(spend.untagged.amount, c)} ({percent(spend.untagged.share)}
          {t("spendPage.hasNoTeamYetGive")} <a href="/rules">{t("spendPage.rules")}</a>.
        </p>
      )}
      {spend && isTime && spend.groups.length > 1 && (
        <Panel title={t("spendPage.overTime")}>
          <TimeSeriesChart
            label={t("spendPage.spendOverTime")}
            series={[{ id: "spend", name: "Spend", data: spend.groups.map((g) => g.amount) }]}
            labels={spend.groups.map((g) => g.key)}
            format={(v) => money(v, c)}
            area
            height={180}
          />
        </Panel>
      )}
      <Panel flush>
        <DataTable
          label={t("spendPage.spend")}
          columns={columns}
          rows={spend?.groups ?? []}
          loading={!spend && !error && !!by}
          getRowId={(g) => g.key}
          minWidth={520}
          pageSize={50}
          empty={
            <EmptyState title={t("spendPage.noSpend")}>
              {t("spendPage.nothingWasSpentInThis")}
              {team ? t("spendPage.byThisTeam") : ""}.
            </EmptyState>
          }
        />
      </Panel>
      {movers && movers.movers.length > 0 && (
        <Panel
          title={t("spendPage.whatMoved")}
          description={t("spendPage.againstTo", { day: day(movers.previousPeriod.from), day2: day(movers.previousPeriod.to) })}
          flush
        >
          <MoversTable movers={movers} />
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Budgets

const BUDGET_LABEL = (t: T): Record<BudgetState, string> => ({ ok: t("budgetLabel.onTrack"), warning: "Past 50%", alert: "Past 80%", over: "Over" });
const BUDGET_TONE: Record<BudgetState, "success" | "info" | "warning" | "danger"> = { ok: "success", warning: "info", alert: "warning", over: "danger" };

function BudgetDialog({ call, currency, onClose, onSaved }: { call: Call; currency: string; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"team" | "tag">("team");
  const [tagKey, setTagKey] = useState("");
  const [value, setValue] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/budgets", {
        method: "POST",
        body: JSON.stringify({ name, scope, value, amount: Number(amount), ...(scope === "tag" && { tagKey }) }),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("budgetDialog.addABudget")}
      description={t("budgetDialog.aMonthlyAmountForA")}
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("budgetDialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !value.trim() || !(Number(amount) > 0) || (scope === "tag" && !tagKey.trim())}>
            {t("budgetDialog.addBudget")}
          </Button>
        </>
      }
    >
      <TextField label={t("budgetDialog.name")} value={name} onChange={(e) => setName(e.target.value)} />
      <SelectField
        label={t("budgetDialog.for")}
        value={scope}
        onChange={(e) => setScope(e.target.value as "team" | "tag")}
        options={[
          { value: "team", label: t("budgetDialog.aTeam") },
          { value: "tag", label: t("budgetDialog.aTagValue") },
        ]}
      />
      <div className="grid grid-cols-2 gap-2">
        {scope === "tag" && (
          <TextField label={t("budgetDialog.tagName")} value={tagKey} onChange={(e) => setTagKey(e.target.value)} hint={t("budgetDialog.suchAsEnv")} />
        )}
        <TextField
          label={scope === "team" ? t("budgetDialog.team") : t("budgetDialog.tagValue")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          hint={scope === "tag" ? t("budgetDialog.suchAsProd") : undefined}
        />
      </div>
      <TextField
        label={t("budgetDialog.eachMonth", { currency })}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={error}
      />
    </Dialog>
  );
}

function BudgetsPage({ call, summary, reload }: { call: Call; summary: Summary; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [budgets, setBudgets] = useState<Budget[]>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Budget>();
  const load = useCallback(
    () =>
      void call<{ budgets: Budget[] }>("/api/v1/budgets").then(
        (r) => setBudgets(r.budgets),
        () => setBudgets([]),
      ),
    [call],
  );
  useEffect(load, [load]);

  const c = summary.currency;
  const columns: Column<Budget>[] = [
    {
      id: "state",
      header: t("budgetsPage.state"),
      width: "110px",
      cell: (b) => <StatusBadge tone={BUDGET_TONE[b.state]}>{BUDGET_LABEL(t)[b.state]}</StatusBadge>,
    },
    {
      id: "name",
      header: t("budgetsPage.budget"),
      width: "26%",
      sortValue: (b) => b.name,
      cell: (b) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{b.name}</span>
          <span className="text-xs text-fg-muted">{b.scope === "team" ? t("budgetsPage.team", { value: b.value }) : `${b.tagKey} = ${b.value}`}</span>
        </span>
      ),
    },
    { id: "spent", header: t("budgetsPage.spent"), align: "right", sortValue: (b) => b.percent, cell: (b) => `${money(b.spent, c)} (${b.percent}%)` },
    { id: "amount", header: t("budgetsPage.budget"), align: "right", cell: (b) => money(b.amount, c) },
    {
      id: "forecast",
      header: t("budgetsPage.forecast"),
      align: "right",
      sortValue: (b) => b.forecastPercent,
      cell: (b) => <span className={b.forecastPercent >= 100 ? "text-danger" : undefined}>{`${money(b.forecast, c)} (${b.forecastPercent}%)`}</span>,
    },
    {
      id: "burn",
      header: t("budgetsPage.burnRate"),
      align: "right",
      sortValue: (b) => b.burnRate,
      cell: (b) => <span className={b.burnRate > 1 ? "text-warning" : undefined}>{b.burnRate.toFixed(2)}</span>,
    },
    ...(can("admin")
      ? [
          {
            id: "remove",
            header: "",
            align: "right" as const,
            width: "56px",
            cell: (b: Budget) => <Button size="sm" icon={<Trash2 />} aria-label={t("budgetsPage.delete", { name: b.name })} onClick={() => setRemoving(b)} />,
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title={t("budgetsPage.budgets")}
        description={t("budgetsPage.aBurnRateAbove1", { month: summary.month })}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("budgetsPage.addBudget")}
            </Button>
          )
        }
      />
      <MissingRates currencies={summary.missingRates} />
      <Panel flush>
        <DataTable
          label={t("budgetsPage.budgets")}
          columns={columns}
          rows={budgets ?? []}
          loading={!budgets}
          getRowId={(b) => b.id}
          minWidth={860}
          empty={
            <EmptyState title={t("budgetsPage.noBudgetsYet")}>
              {can("admin") ? t("budgetsPage.addAMonthlyBudgetFor") : t("budgetsPage.anAdminAddsTheBudgets")}
            </EmptyState>
          }
        />
      </Panel>
      <p className="m-0 text-xs text-fg-muted">{t("budgetsPage.theForecastIsTheSpend")}</p>
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
          title={t("budgetsPage.delete2", { name: removing.name })}
          description={t("budgetsPage.theSpendStaysOnlyThe")}
          footer={
            <>
              <Button type="button" onClick={() => setRemoving(undefined)}>
                {t("budgetsPage.cancel")}
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
                {t("budgetsPage.delete3")}
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
  const t = useT();
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
      title={t("decideDialog.on", { service: anomaly.service, day: day(anomaly.date) })}
      description={t("decideDialog.againstAUsualInAccount", {
        money: money(anomaly.amount, anomaly.currency),
        money2: money(anomaly.usual, anomaly.currency),
        account: anomaly.account,
      })}
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("decideDialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={status === "expected" && reason.trim().length < 3}>
            {t("decideDialog.save")}
          </Button>
        </>
      }
    >
      <SelectField
        label={t("decideDialog.whatItIs")}
        value={status}
        onChange={(e) => setStatus(e.target.value as AnomalyStatus)}
        options={[
          { value: "acknowledged", label: t("decideDialog.acknowledgedSomeoneIsLooking") },
          { value: "expected", label: t("decideDialog.expectedWeKnewAndWhy") },
          { value: "new", label: t("decideDialog.newNobodyHasLooked") },
        ]}
      />
      <TextField
        label={t("decideDialog.reason")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint={status === "expected" ? t("decideDialog.requiredALoadTestA") : t("decideDialog.optional")}
        error={error}
      />
    </Dialog>
  );
}

function AnomaliesPage({ call, summary, reload }: { call: Call; summary: Summary; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState<AnomalyStatus>("new");
  const [rows, setRows] = useState<Anomaly[]>();
  const [deciding, setDeciding] = useState<Anomaly>();
  const load = useCallback(() => {
    setRows(undefined);
    void call<{ anomalies: Anomaly[] }>(`/api/v1/anomalies?status=${tab}&limit=500`).then(
      (r) => setRows(r.anomalies),
      () => setRows([]),
    );
  }, [call, tab]);
  useEffect(load, [load]);

  const columns: Column<Anomaly>[] = [
    {
      id: "date",
      header: t("anomaliesPage.day"),
      width: "90px",
      sortValue: (a) => a.date,
      cell: (a) => <span className="whitespace-nowrap text-xs">{day(a.date)}</span>,
    },
    {
      id: "service",
      header: t("anomaliesPage.service"),
      width: "30%",
      cell: (a) => (
        <span className="flex min-w-0 flex-col">
          <span className="cost-wrap font-medium">{a.service}</span>
          <span className="text-xs text-fg-muted">{t("anomaliesPage.account", { account: a.account })}</span>
        </span>
      ),
    },
    { id: "amount", header: t("anomaliesPage.cost"), align: "right", cell: (a) => money(a.amount, a.currency) },
    { id: "usual", header: t("anomaliesPage.usual"), align: "right", cell: (a) => money(a.usual, a.currency) },
    {
      id: "extra",
      header: t("anomaliesPage.more"),
      align: "right",
      sortValue: (a) => a.extra,
      cell: (a) => <span className="text-danger">+{money(a.extra, a.currency)}</span>,
    },
    { id: "status", header: t("anomaliesPage.status"), cell: (a) => <StatusBadge tone={ANOMALY_TONE[a.status]}>{ANOMALY_LABEL[a.status]}</StatusBadge> },
    {
      id: "reason",
      header: t("anomaliesPage.reason"),
      width: "22%",
      cell: (a) => (
        <span className="cost-clamp text-xs text-fg-muted" title={a.reason ?? undefined}>
          {a.reason ?? ""}
          {a.decidedBy ? ` (${a.decidedBy})` : ""}
        </span>
      ),
    },
    ...(can("editor")
      ? [
          {
            id: "decide",
            header: "",
            align: "right" as const,
            width: "90px",
            cell: (a: Anomaly) => (
              <Button size="sm" onClick={() => setDeciding(a)}>
                {t("anomaliesPage.decide")}
              </Button>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader title={t("anomaliesPage.anomalies")} description={t("anomaliesPage.aDayOfOneService")} />
      <SegmentedControl
        label={t("anomaliesPage.status")}
        value={tab}
        onChange={setTab}
        options={[
          { value: "new", label: t("anomaliesPage.new", { value: summary.anomaliesOpen ? ` (${summary.anomaliesOpen})` : "" }) },
          { value: "acknowledged", label: t("anomaliesPage.acknowledged") },
          { value: "expected", label: t("anomaliesPage.expected") },
        ]}
      />
      <Panel flush>
        <DataTable
          label={t("anomaliesPage.anomalies")}
          columns={columns}
          rows={rows ?? []}
          loading={!rows}
          getRowId={(a) => a.id}
          minWidth={900}
          pageSize={50}
          empty={
            <EmptyState title={tab === "new" ? t("anomaliesPage.nothingUnusual") : t("anomaliesPage.none")}>
              {tab === "new" ? t("anomaliesPage.noDayHasCostFar") : t("anomaliesPage.nothingHasBeenDecidedThis")}
            </EmptyState>
          }
        />
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
  const t = useT();
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
      await call("/api/v1/rules", {
        method: "PUT",
        body: JSON.stringify({
          rules: (rules ?? []).map((r) => ({ kind: r.kind, match: r.match, team: r.team, ...(r.kind === "tag" && { tagKey: r.tagKey }) })),
        }),
      });
      setError(undefined);
      load();
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <PageHeader title={t("rulesPage.rules")} description={t("rulesPage.whoOwnsSpendThatHas")} />
      <Panel title={t("rulesPage.inOrder")} description={t("rulesPage.serviceNamesTakeAndAs")}>
        {!rules ? null : !rules.length && !admin ? (
          <p className="m-0 text-sm text-fg-muted">{t("rulesPage.noRulesSpendWithoutA")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {rules.map((r, i) => (
              <div key={i} className="cost-rule flex flex-wrap items-end gap-2">
                <SelectField
                  label={t("rulesPage.when")}
                  value={r.kind}
                  disabled={!admin}
                  onChange={(e) => change(i, { kind: e.target.value as Rule["kind"] })}
                  options={[
                    { value: "account", label: t("rulesPage.accountIs") },
                    { value: "service", label: t("rulesPage.serviceIs") },
                    { value: "tag", label: t("rulesPage.tagIs") },
                  ]}
                />
                {r.kind === "tag" && (
                  <TextField label={t("rulesPage.tagName")} value={r.tagKey} disabled={!admin} onChange={(e) => change(i, { tagKey: e.target.value })} />
                )}
                <TextField
                  label={r.kind === "account" ? t("rulesPage.accountId") : r.kind === "service" ? t("rulesPage.service") : t("rulesPage.tagValue")}
                  value={r.match}
                  disabled={!admin}
                  onChange={(e) => change(i, { match: e.target.value })}
                />
                <TextField label={t("rulesPage.team")} value={r.team} disabled={!admin} onChange={(e) => change(i, { team: e.target.value })} />
                {admin && <Button icon={<Trash2 />} aria-label={t("rulesPage.removeRule")} onClick={() => setRules((rs) => rs?.filter((_, j) => j !== i))} />}
              </div>
            ))}
            {admin && (
              <div className="flex flex-wrap items-center gap-2">
                <Button icon={<Plus />} onClick={() => setRules((rs) => [...(rs ?? []), { kind: "account", match: "", tagKey: "", team: "" }])}>
                  {t("rulesPage.addRule")}
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={JSON.stringify(rules) === saved}>
                  {t("rulesPage.saveRules")}
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
  const t = useT();
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

  const loadRates = useCallback(
    () =>
      void call<{ rates: Rate[] }>("/api/v1/rates").then(
        (r) => setRates(r.rates),
        () => setRates([]),
      ),
    [call],
  );
  useEffect(() => {
    void call<Settings>("/api/v1/settings").then(
      (s) => (setSettings(s), setCurrency(s.currency), setMinimum(String(s.anomalyMinimum))),
      () => {},
    );
    loadRates();
  }, [call, loadRates]);

  const put = async () => {
    try {
      const s = await call<Settings>("/api/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ currency: currency.trim().toUpperCase(), anomalyMinimum: Number(minimum) }),
      });
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
    { id: "currency", header: t("costSettingsPage.currency"), cell: (r) => <Badge>{r.currency}</Badge> },
    {
      id: "rate",
      header: settings ? t("costSettingsPage.oneUnitIn", { currency: settings.currency }) : t("costSettingsPage.rate"),
      align: "right",
      cell: (r) => r.rate,
    },
    ...(admin
      ? [
          {
            id: "remove",
            header: "",
            align: "right" as const,
            width: "56px",
            cell: (r: Rate) => (
              <Button
                size="sm"
                icon={<Trash2 />}
                aria-label={t("costSettingsPage.deleteTheRateOf", { currency: r.currency })}
                onClick={() => void call(`/api/v1/rates/${r.currency}`, { method: "DELETE" }).then(() => (loadRates(), reload()))}
              />
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader title={t("costSettingsPage.settings")} description={t("costSettingsPage.theCurrencyFiguresAreShown")} />
      {settings && (
        <Panel title={t("costSettingsPage.reporting")}>
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField
              label={t("costSettingsPage.reportingCurrency")}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={!admin}
              hint={t("costSettingsPage.aThreeLetterCodeSuch")}
            />
            <TextField
              label={t("costSettingsPage.anAnomalyIsAtLeast", { currency: settings.currency })}
              inputMode="decimal"
              value={minimum}
              onChange={(e) => setMinimum(e.target.value)}
              disabled={!admin}
              error={error}
            />
          </div>
          {admin && (
            <div className="mt-3">
              <Button
                variant="primary"
                onClick={() => void put()}
                disabled={currency.trim().toUpperCase() === settings.currency && Number(minimum) === settings.anomalyMinimum}
              >
                {t("costSettingsPage.save")}
              </Button>
            </div>
          )}
        </Panel>
      )}
      <Panel title={t("costSettingsPage.rates")} description={t("costSettingsPage.spendInACurrencyWithout")} flush>
        <DataTable
          label={t("costSettingsPage.rates")}
          columns={columns}
          rows={rates ?? []}
          loading={!rates}
          getRowId={(r) => r.currency}
          minWidth={360}
          empty={<EmptyState title={t("costSettingsPage.noRates")}>{t("costSettingsPage.allSpendIsInThe")}</EmptyState>}
        />
      </Panel>
      {admin && (
        <Panel title={t("costSettingsPage.setARate")} description={t("costSettingsPage.aRateForACurrency")}>
          <form className="flex flex-col gap-2" onSubmit={putRate}>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField label={t("costSettingsPage.currency")} value={rateCurrency} onChange={(e) => setRateCurrency(e.target.value)} placeholder="EUR" />
              <TextField
                label={settings ? t("costSettingsPage.oneUnitIn", { currency: settings.currency }) : t("costSettingsPage.rate")}
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="1.08"
                error={rateError}
              />
            </div>
            <div>
              <Button type="submit" variant="primary" disabled={!/^[A-Za-z]{3}$/.test(rateCurrency.trim()) || !(Number(rate) > 0)}>
                {t("costSettingsPage.setRate")}
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.aPipelineSendsTheBill")} />
      <Panel title="AWS" description={t("setupPage.costExplorerSAnswerTurned")}>
        <Code>{`aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-22 --granularity DAILY \\
  --metrics UnblendedCost \\
  --group-by Type=DIMENSION,Key=LINKED_ACCOUNT Type=DIMENSION,Key=SERVICE Type=TAG,Key=team \\
  | node tools/ce-to-records.mjs \\
  | curl -sf -X POST -H "Authorization: Bearer $COST_INGEST_TOKEN" -H 'content-type: application/json' \\
    --data-binary @- "${origin}/api/v1/records?replace=true"`}</Code>
      </Panel>
      <Panel title={t("setupPage.anythingElse")} description={t("setupPage.jsonNdjsonOrCsvOptionally")}>
        <Code>{`curl -sf -X POST -H "Authorization: Bearer $COST_INGEST_TOKEN" -H 'content-type: text/csv' \\
  --data-binary @spend.csv "${origin}/api/v1/records"

date,provider,account,service,amount,currency,tag:team
2026-10-21,gcp,my-project,Compute Engine,412.30,USD,payments`}</Code>
      </Panel>
      <Panel title={t("setupPage.whatToKnow")}>
        <ul className="cost-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>{t("setupPage.aDaySentAgainReplaces")}</li>
          <li>{t("setupPage.aTeamTagNamesThe")}</li>
          <li>{t("setupPage.creditsAreNegativeAmountsSpend")}</li>
          <li>/metrics has month-to-date by team, each budget's share and burn rate, and open anomalies, for Prometheus.</li>
        </ul>
      </Panel>
    </>
  );
}

/** The first screen, until spend arrives. The summary is polled, so it gives way by itself. */
function WelcomePage() {
  const t = useT();
  return (
    <>
      <PageHeader
        title={t("welcomePage.getStarted")}
        description={t("welcomePage.sendTheFirstDayOf")}
        actions={<StatusBadge tone="info">{t("welcomePage.waitingForSpend")}</StatusBadge>}
      />
      <SetupPage />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdminOfThis")}</EmptyState>;
  const titles = {
    account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
    members: [
      "Members",
      "Who can sign in to this cost, and with which role. Viewers see everything; editors also send spend and decide on anomalies; admins also change budgets, rules, rates and settings, and manage members and tokens.",
    ],
    signin: [
      "Sign-in",
      "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role.",
    ],
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
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
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
    { id: "overview", label: msg("product.overview"), icon: LayoutDashboard },
    { id: "spend", label: msg("product.spend"), icon: ChartColumn },
    { id: "budgets", label: msg("product.budgets"), icon: Wallet, count: summary?.budgetsAtRisk || undefined },
    { id: "anomalies", label: msg("product.anomalies"), icon: BellRing, count: summary?.anomaliesOpen || undefined },
    { id: "rules", label: msg("product.rules"), icon: Waypoints },
  ];
  const footerNav = [
    { id: "setup", label: msg("product.setup"), icon: Settings2 },
    { id: "settings", label: msg("product.settings"), icon: SlidersHorizontal },
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
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
        <EmptyState title={msg("product.loading")} icon={<Coins />}>
          {msg("product.readingTheSpend")}
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
