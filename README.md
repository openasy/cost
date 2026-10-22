# cost

[![CI](https://github.com/openasy/cost/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/cost/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Cost product: **cloud spend by team and tag, with budgets, forecasts and
anomaly alerts** (ADR 0051). A pipeline sends the bill; Cost holds no cloud credentials and calls no cloud API.

```
aws ce get-cost-and-usage | tools/ce-to-records.mjs ──POST /api/v1/records──▶  cost  ──▶  spend by team, service, tag
a GCP or Azure export, or any CSV ─────────────────────────────────────▶        ├── budgets and the month's forecast
                                                                                └── anomalies, /metrics to alert on
```

## Spend in

A spend line is one day of one service in one account: `{ date, provider, account, service, amount, currency, region?,
resource?, usageType?, tags? }`. Send a JSON array (or `{ records: [...] }`), NDJSON or CSV, optionally gzipped, up to
200,000 lines a call. In CSV, tags are columns named `tag:team`.

```bash
# AWS: Cost Explorer's answer, turned into lines by tools/ce-to-records.mjs (no packages needed)
aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-22 --granularity DAILY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=LINKED_ACCOUNT Type=DIMENSION,Key=SERVICE Type=TAG,Key=team \
  | node tools/ce-to-records.mjs \
  | curl -sf -X POST -H "Authorization: Bearer $COST_INGEST_TOKEN" -H 'content-type: application/json' --data-binary @- \
    "https://cost.example.com/api/v1/records?replace=true"

# anything else
curl -sf -X POST -H "Authorization: Bearer $COST_INGEST_TOKEN" -H 'content-type: text/csv' --data-binary @spend.csv \
  https://cost.example.com/api/v1/records
```

- A line with the same day, provider, account, service, region, resource, usage type and currency as one that exists
  **replaces** it, so a daily job can send the whole month again. With `?replace=true`, the days in the call are cleared
  for their provider and account first, so lines the new export no longer has disappear.
- Lines with the same key in one call are added together, as a bill with many lines for one resource needs.
- A wrong line is named, with its field, and nothing of the call is kept.
- Amounts are kept as millionths, so sums do not drift. Credits are negative amounts.

## Who spent it

A `team` tag on a line names the team. Spend without one goes to the first **rule** that matches its account, its
service (`*` and `?` are wildcards) or another tag, and otherwise to nobody: the overview shows how much nobody owns yet.

## Currencies

Figures are in one **reporting currency** (USD unless changed). Spend in another currency counts once an admin sets
what it is worth under Settings; until then it is left out, and every page that shows figures names the currency.
Rates are fixed until changed: nothing is fetched.

## Budgets, forecast and anomalies

- A **budget** is a monthly amount for a team or a tag value. It shows what is spent, its **burn rate** (spend against
  the straight line to the budget: above 1 runs out early) and its state at 50%, 80% and 100%.
- The **forecast** is the spend so far plus the last seven days' daily rate for the days left in the month.
- An **anomaly** is a day of one service in one account that cost more than the mean of the 14 days before it plus three
  standard deviations, and by more than the anomaly minimum (50 in the reporting currency; change under Settings). A day
  nobody sent counts as zero. Someone acknowledges it, or marks it expected with a reason; the decision stays when the
  day is sent again with the same spike, and the anomaly goes when it is sent without it.

## Run

```bash
openssl rand -hex 32 > openasy-kek
export COST_INGEST_TOKEN=$(openssl rand -hex 32)
docker compose up -d
docker compose logs cost | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

`openasy-kek` encrypts sign-in secrets in the database (ADR 0021). Keep it apart from the volume and with your backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `COST_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `COST_INGEST_TOKEN` | | Lets a pipeline send spend and nothing else. An API token with the editor role works too |
| `COST_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `COST_DB` | `/data/cost.db` | SQLite file (WAL), on the `/data` volume |
| `COST_RETENTION_DAYS` | `800` | Spend older than this is deleted; the default keeps two years to compare with |
| `COST_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `COST_HEADLESS` | `false` | `true` serves only the API |
| `COST_PASSWORD_SIGN_IN`, `COST_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has `openasy_cost_month_to_date{team,currency}`, `openasy_cost_budget_percent{budget}`,
`openasy_cost_budget_burn_rate{budget}` and `openasy_cost_anomalies_open`, to alert on in your own Prometheus.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see everything; editors also send spend and decide on anomalies; admins also change budgets, rules, rates and
settings, and manage members and API tokens (ADR 0003).

## Develop

```bash
npm install
npm test        # parsing, exact sums, owners, forecast, anomalies, the converter, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
