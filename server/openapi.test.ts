import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, days, INGEST_TOKEN, lines, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "cost-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // cost's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let budget = "";
  let anomaly = "";
  const feed = lines(
    ...days("2026-10-01", 14, 100, { tags: { team: "platform", env: "prod" } }),
    ...days("2026-10-01", 14, 10, { account: "222", service: "Amazon S3" }),
  );
  const send = (body: string, type = "application/json", token = INGEST_TOKEN) => auth(token, body, type);
  const records = "/api/v1/records";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("spend in, in every shape, and every refusal", async () => {
    await call("POST", records, send(feed), records);
    await call("POST", records, send(feed), `${records}?replace=true`);
    await call(
      "POST",
      records,
      send('{"date":"2026-09-01","provider":"gcp","account":"p","service":"BigQuery","amount":1,"currency":"USD"}\n', "application/x-ndjson"),
      records,
    );
    await call("POST", records, send("date,provider,account,service,amount,currency\n2026-09-02,gcp,p,BigQuery,1,USD\n", "text/csv"), records);
    const spike = await call("POST", records, send(lines({ date: "2026-10-15", amount: 400 })), records);
    expect((spike.body as { anomaliesOpen: number }).anomaliesOpen).toBe(1);
    await call("POST", records, send("[]"), records);
    await call("POST", records, send("{nope"), records);
    await call("POST", records, send(lines({ date: "2026-10-15", amount: 1 }).replace('"amount":1', '"amount":"x"')), records);
    await call("POST", records, send(feed), `${records}?replace=maybe`);
    await call("POST", records, send(feed, "application/json", "wrong"), records);
    await call("POST", records, { method: "POST" }, records);
  });

  it("spend out", async () => {
    const q = "from=2026-10-01&to=2026-10-14";
    await call("GET", "/api/v1/spend", admin(), "/api/v1/spend");
    await call("GET", "/api/v1/spend", admin(), `/api/v1/spend?groupBy=service&${q}`);
    await call("GET", "/api/v1/spend", admin(), `/api/v1/spend?groupBy=tag:env&team=platform&provider=aws&tag.env=prod&${q}`);
    await call("GET", "/api/v1/spend", admin(), `/api/v1/spend?groupBy=week&${q}`);
    await call("GET", "/api/v1/spend", admin(), "/api/v1/spend?groupBy=colour");
    await call("GET", "/api/v1/spend", {});
    await call("GET", "/api/v1/spend/movers", admin(), "/api/v1/spend/movers?groupBy=service&from=2026-10-08&to=2026-10-14");
    await call("GET", "/api/v1/spend/movers", admin(), "/api/v1/spend/movers?groupBy=day");
    await call("GET", "/api/v1/spend/movers", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", admin(), "/api/v1/summary?asOf=2026-10-14");
    await call("GET", "/api/v1/summary", admin(), "/api/v1/summary?asOf=soon");
    await call("GET", "/api/v1/summary", {});
  });

  it("settings, rates and rules", async () => {
    await call("GET", "/api/v1/settings", admin());
    await call("PUT", "/api/v1/settings", admin({ anomalyMinimum: 25 }));
    await call("PUT", "/api/v1/settings", admin({ currency: "usd" }));
    await call("PUT", "/api/v1/settings", admin({}));
    await call("GET", "/api/v1/settings", {});
    await call("PUT", "/api/v1/settings", {});
    await call("GET", "/api/v1/rates", admin());
    await call("PUT", "/api/v1/rates/{currency}", admin({ rate: 1.1 }), "/api/v1/rates/EUR");
    await call("PUT", "/api/v1/rates/{currency}", admin({ rate: 0 }), "/api/v1/rates/EUR");
    await call("PUT", "/api/v1/rates/{currency}", admin({ rate: 1 }), "/api/v1/rates/USD");
    await call("PUT", "/api/v1/rates/{currency}", { method: "PUT" }, "/api/v1/rates/EUR");
    await call("DELETE", "/api/v1/rates/{currency}", admin(), "/api/v1/rates/EUR");
    await call("DELETE", "/api/v1/rates/{currency}", admin(), "/api/v1/rates/EUR");
    await call("DELETE", "/api/v1/rates/{currency}", { method: "DELETE" }, "/api/v1/rates/EUR");
    await call("GET", "/api/v1/rules", admin());
    await call(
      "PUT",
      "/api/v1/rules",
      admin({
        rules: [
          { kind: "account", match: "222", team: "data" },
          { kind: "tag", tagKey: "env", match: "prod", team: "ops" },
        ],
      }),
    );
    await call("PUT", "/api/v1/rules", admin({ rules: [{ kind: "region", match: "x", team: "t" }] }));
    await call("PUT", "/api/v1/rules", admin("nope"));
    await call("GET", "/api/v1/rules", {});
    await call("PUT", "/api/v1/rules", { method: "PUT" });
  });

  it("budgets", async () => {
    budget = ((await call("POST", "/api/v1/budgets", admin({ name: "Platform", scope: "team", value: "platform", amount: 3000 }))).body as { id: string }).id;
    await call("POST", "/api/v1/budgets", admin({ name: "Platform", scope: "team", value: "platform", amount: 1 }));
    await call("POST", "/api/v1/budgets", admin({ name: "Bad", scope: "team", value: "x", amount: 0 }));
    await call("POST", "/api/v1/budgets", admin("nope"));
    await call("POST", "/api/v1/budgets", { method: "POST" });
    await call("GET", "/api/v1/budgets", admin());
    await call("GET", "/api/v1/budgets", admin(), "/api/v1/budgets?asOf=2026-10-14");
    await call("GET", "/api/v1/budgets", admin(), "/api/v1/budgets?asOf=soon");
    await call("GET", "/api/v1/budgets", {});
  });

  it("anomalies", async () => {
    const list = (await call("GET", "/api/v1/anomalies", admin())).body as { anomalies: Array<{ id: string }> };
    anomaly = list.anomalies[0]!.id;
    await call("GET", "/api/v1/anomalies", admin(), "/api/v1/anomalies?status=new&limit=1");
    await call("GET", "/api/v1/anomalies", admin(), "/api/v1/anomalies?status=old");
    await call("GET", "/api/v1/anomalies", admin(), "/api/v1/anomalies?cursor=junk");
    await call("GET", "/api/v1/anomalies", {});
    await call("PUT", "/api/v1/anomalies/{id}", admin({ status: "expected", reason: "The launch" }), `/api/v1/anomalies/${anomaly}`);
    await call("PUT", "/api/v1/anomalies/{id}", admin({ status: "expected" }), `/api/v1/anomalies/${anomaly}`);
    await call("PUT", "/api/v1/anomalies/{id}", admin("nope"), `/api/v1/anomalies/${anomaly}`);
    await call("PUT", "/api/v1/anomalies/{id}", admin({ status: "acknowledged" }), "/api/v1/anomalies/missing");
    await call("PUT", "/api/v1/anomalies/{id}", { method: "PUT" }, `/api/v1/anomalies/${anomaly}`);
  });

  it("deletes a budget", async () => {
    await call("DELETE", "/api/v1/budgets/{id}", admin(), `/api/v1/budgets/${budget}`);
    await call("DELETE", "/api/v1/budgets/{id}", admin(), `/api/v1/budgets/${budget}`);
    await call("DELETE", "/api/v1/budgets/{id}", { method: "DELETE" }, "/api/v1/budgets/x");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
