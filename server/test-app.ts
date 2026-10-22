// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { createCost } from "./cost.ts";
import { openDb } from "./db.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const ADMIN_TOKEN = "test-admin-token";

export interface Line {
  date: string;
  service?: string;
  account?: string;
  amount: number;
  currency?: string;
  provider?: string;
  region?: string;
  resource?: string;
  usageType?: string;
  tags?: Record<string, string>;
}

/** Spend lines as a pipeline sends them. */
export const lines = (...l: Line[]) => JSON.stringify(l.map((x) => ({ provider: "aws", account: "111", service: "Amazon EC2", currency: "USD", ...x })));

/** The days from `from` for `n` days, each spending `amount`. */
export function days(from: string, n: number, amount: number | ((i: number) => number), rest: Omit<Line, "date" | "amount"> = {}): Line[] {
  return Array.from({ length: n }, (_, i) => ({ ...rest, date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), amount: typeof amount === "number" ? amount : amount(i) }));
}

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const db = openDb(":memory:");
  const cost = createCost(db);
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "cost", productName: "OpenAsy Cost", origin: base });
  handler = createApp({ db, cost, auth, ingestToken: INGEST_TOKEN, adminToken: ADMIN_TOKEN, ...opts });
  const as = (token: string) => (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const ingest = as(INGEST_TOKEN);
  /** Sends spend the way a pipeline does. */
  const send = (body: string | Buffer, query = "", headers: Record<string, string> = {}) => ingest(`/api/v1/records${query}`, { method: "POST", body, headers });
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, cost, auth, base, admin, ingest, send, get, close };
}
