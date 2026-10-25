// What the search window (Cmd+K) finds in Cost: budgets by name or what they cover. They are read whole and filtered
// here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Wallet } from "lucide-react";
import type { Budget } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const found = await call<{ budgets: Budget[] }>("/api/v1/budgets", { signal });
    return found.budgets
      .filter((b) => [b.name, b.value].some((x) => x.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((b): SearchResult => ({
        id: `budget:${b.id}`,
        label: b.name,
        detail: t("search.budgetDetail", { percent: Math.round(b.percent), month: b.month }),
        kind: t("search.budget"),
        icon: Wallet,
        severity: b.reached === 100 ? "high" : b.reached === 80 ? "medium" : undefined,
        href: "/budgets",
      }));
  };
}
