# Employee sync demo — BambooHR → Striim → PostgreSQL → Workday

A local dashboard that shows one employee record travelling across four systems, with every status
on screen read from the database rather than from a timer.

```
npm run syncdemo          # → http://localhost:3000
```

---

## 1. Architecture

```
        ┌──────────────────┐
        │     BambooHR     │   source of truth. Employees originate here.
        │  source system   │   adapters/bamboohr.ts  (mock | live)
        └────────┬─────────┘
                 │  change detected by polling — NOT pushed by the create call
                 ▼
        ┌──────────────────┐
        │      STRIIM      │   detect → transform → land
        │  integration     │   adapters/striim.ts    (mock | live)
        └────────┬─────────┘
                 │  writes the LANDING table
                 ▼
        ┌──────────────────┐
        │    PostgreSQL    │   landing → mapping → the table the website reads
        │  intermediate    │   db.ts   (always real)
        └────────┬─────────┘
                 │  downstream sync
                 ▼
        ┌──────────────────┐
        │     Workday      │   target system
        │  target system   │   adapters/workday.ts   (mock | live)
        └──────────────────┘

                 ▲  state + events
                 │
        ┌────────┴─────────┐
        │  Fastify server  │  REST + Server-Sent Events   server/index.ts
        │  Dashboard       │  ui/  (no build step)
        └──────────────────┘
```

**Three ports, two implementations each.** `SourceSystem`, `IntegrationLayer` and `TargetSystem`
in `adapters/types.ts` are the only things `pipeline.ts` knows about. Mock and live are
interchangeable, which means demo mode is not a separate code path that can rot — the same
orchestrator, the same idempotency and the same tests exercise both.

### The two rules the design exists to enforce

**The create call does not push the record downstream.** `POST /api/employees` writes to the
source system and returns `202`. It does not touch the landing table, the intermediate table, or
Workday, and it does not nudge the poller. Everything after the source happens because the
integration layer *notices* the change. That is the difference between demonstrating a pipeline and
animating one, and there is a test that asserts it: immediately after the create, only the
`bamboohr` stage is `synced` and `syncdemo.employees` still has zero rows.

**Every stage claims its work before doing it.** At-least-once delivery is the normal case in a
polling pipeline, not an edge case: the watermark advances *after* the landing write, so a crash in
between re-reads the change. `processed_steps` holds a deterministic key per
`employee_id + stage + revision`, claimed with `INSERT … ON CONFLICT DO NOTHING`, so a redelivered
change, a double-click and a retry all collapse onto one row. A failed stage *releases* its claim,
because a claim that outlives its failure makes a stage permanently unretryable.

### The UI never invents state

`app.js` renders `GET /api/snapshot`, which reads Postgres. The SSE stream carries notifications,
not truth: when one arrives the client re-fetches the snapshot (coalesced) and re-renders. There is
no client-side timer that advances a stage and no optimistic "probably done by now". If the
pipeline stalls, the dashboard stalls with it.

SSE rather than WebSockets because the traffic is one-directional — the server narrates, the
browser listens — and everything the browser sends is already a plain POST. SSE gets reconnection
from the browser for free and needs no dependency.

---

## 2. Folder structure

```
src/syncdemo/
  server/
    index.ts              Fastify: dashboard, REST, SSE. The entry point.
    config.ts             env → config; per-system live/mock resolution
    bus.ts                in-process pub/sub → SSE fan-out
    db.ts                 ALL SQL. Nothing above this file writes a query.
    pipeline.ts           the orchestrator: stages, idempotency, retry, snapshot
    adapters/
      types.ts            the three ports + the fault switches
      bamboohr.ts         MockBambooHR | LiveBambooHR
      striim.ts           MockStriim | LiveStriim + the transform step
      workday.ts          MockWorkday | LiveWorkday
  sql/schema.sql          the schema, with __SCHEMA__ substituted at migrate time
  ui/
    index.html            dashboard markup
    app.css               tokens on :root, redefined for dark mode
    app.js                SSE client + render. No framework, no build step.
  Dockerfile
  README.md               this file

test/syncdemo/pipeline.test.ts    20 tests: the critical sync path
docker-compose.syncdemo.yml       app + its own Postgres
```

Reused rather than rewritten:
`src/platform/hris/bamboohrClient.ts` (the tested write path into a real HRIS),
`src/platform/hris/adaptiveClient.ts` (the two-hop Workday OAuth chain),
`src/platform/db/poolGuard.ts` (without it a Neon idle-connection drop kills the process).

---

## 3. Setup

Requires Node ≥ 20 and a Postgres. Nothing else.

```bash
npm install
npm run syncdemo
```

With `LEDGER_DATABASE_URL` already in `.env` — as it is in this repo — that is the whole setup.
The app creates its own `syncdemo` schema on boot and touches nothing else in the database.

### Docker

```bash
docker compose -f docker-compose.syncdemo.yml up --build
# → http://localhost:3000
```

Two containers: the app and its own Postgres on host port 5434 (5432 is usually taken and 5433 is
this repo's other compose Postgres). It runs fully mocked.

---

## 4. Environment variables

Nothing is required. Everything below has a working default.

| Variable | Default | Purpose |
|---|---|---|
| `SYNCDEMO_PORT` | `3000` | HTTP port |
| `SYNCDEMO_MODE` | `mock` | `mock` \| `live` — global default for all three systems |
| `SYNCDEMO_BAMBOOHR_MODE` | — | per-system override, beats `SYNCDEMO_MODE` |
| `SYNCDEMO_STRIIM_MODE` | — | ditto |
| `SYNCDEMO_WORKDAY_MODE` | — | ditto |
| `SYNCDEMO_SCHEMA` | `syncdemo` | Postgres schema this instance owns |
| `SYNCDEMO_STRIIM_POLL_MS` | `1500` | mock change-detection interval |
| `SYNCDEMO_STRIIM_LIVE_POLL_MS` | `10000` | how often the live adapter re-reads the landing table |
| `SYNCDEMO_DATABASE_URL` | — | wins over everything below |
| `POSTGRES_HOST/PORT/DB/USER/PASSWORD/SSLMODE` | — | the discrete form; what compose sets |
| `LEDGER_DATABASE_URL` | — | final fallback: this repo's existing database |
| `BAMBOOHR_API_KEY`, `BAMBOOHR_DOMAIN` | — | required for live BambooHR |
| `WORKDAY_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/TOKEN_URL/TOKEN_EXCHANGE_URL/BASE_URL` | — | live Workday. `ADAPTIVE_*` names are accepted as aliases |
| `STRIIM_URL`, `STRIIM_USER`, `STRIIM_PASSWORD` | — | live Striim (`STRIIM_PASS` also accepted) |
| `SYNCDEMO_TEST_DATABASE_URL` | — | test database; unset ⇒ the DB tests skip |

Secrets are read from the environment only, never hardcoded, and `.env` is already gitignored.
`publicConfig()` sends the browser a mode and a target label — never a credential.

### Why mock is the default even when credentials exist

The brief asks for live mode when credentials are present. It is there, behind
`SYNCDEMO_MODE=live`, and that extra step is deliberate. This repo's `.env` holds working BambooHR
and Workday Adaptive credentials. "Credentials present, therefore live" would mean that clicking
**Create Employee** on a demo dashboard creates a **real person in a real HRIS** and writes a
**real row into a Workday Adaptive planning model** that a pay-equity agent reads. Neither is
reversible from this UI. An explicit opt-in is one variable; an accidental write into a planning
model is a phone call.

In live mode each system is independent: one with credentials goes live, one without stays mocked,
and the dashboard badges say which is which per system.

---

## 5. Running the demo

1. `npm run syncdemo`, open **http://localhost:3000**.
2. Press **Fill demo values** for the record below, or **+ Create Employee in BambooHR** to type it.

   | | |
   |---|---|
   | Employee ID | `EMP-1001` |
   | First / Last | Sarah / Smith |
   | Email | sarah@example.com |
   | Job title | Forward Deployed Engineer |
   | Department | Engineering |
   | Location | San Francisco |

3. Press **Create**. Then stop touching it. In mock mode the four stages complete in about three
   seconds, and no page refresh is needed at any point:

```
BambooHR    ✓ synced      created in BambooHR as EMP-1001
Striim      ✓ synced      landed in the PostgreSQL landing table
PostgreSQL  ✓ synced      row committed to syncdemo.employees
Workday     ✓ synced      worker WD-DC2D4E99 created
```

### Showing a failure

Open **Failure simulation**, tick *Workday sync fails*, create an employee. The pipeline stops:

```
BambooHR ✓   Striim ✓   PostgreSQL ✓   Workday ✗
```

The error appears in the activity log with the reason. Untick the fault, press **Retry** on that
row, and it completes — without writing a second employee or a second worker.

Ticking *PostgreSQL write fails* gives the other shape: Workday stays `pending`, not `failed`,
because nothing downstream was attempted.

### Proving it is not a mockup

- `psql -c 'select * from syncdemo.employees'` — the row the dashboard shows.
- `select * from syncdemo.mock_bamboohr_employees` — the source system's own table, a different row.
- `select * from syncdemo.mock_workday_workers` — Workday's own record, with its own `worker_id`.
- Stop the server mid-demo and restart it: state survives, because it was never in memory.

---

## 6. The data flow, step by step

| # | Where | What happens | Evidence |
|---|---|---|---|
| 1 | `POST /api/employees` | Validate. Write to the **source system**, idempotent on email. Mark `bamboohr` synced. Return `202`. | `mock_bamboohr_employees` gains a row with a new `revision` |
| 2 | Striim poller | Reads rows with `revision >` its watermark. This is a real diff, not a callback from step 1. | `Striim detected employee.created event` |
| 3 | Striim | `transform()` — trim, lower-case the email, drop blanks, stamp `source_system`. | `Striim transforming employee record` |
| 4 | Striim | Write the **landing** row, then advance the watermark. In that order. | `syncdemo.landing` |
| 5 | Postgres stage | Claim `employee:postgres:revision`. Map landing → `syncdemo.employees` with `ON CONFLICT DO UPDATE`. | `PostgreSQL INSERT successful` |
| 6 | Workday stage | Claim `employee:workday:revision`. Sync to the target, which assigns **its own** id. | `Workday employee record created (WD-…)` |
| 7 | | `sync_status = 'synced'`. | `EMP-1001 synchronization completed` |

`employee_id` is the correlation key and is identical in all four systems; Workday's `worker_id` is
local to Workday. There is a test for exactly that.

---

## 7. Tests

```bash
npm run syncdemo:test
```

20 tests. The pure ones (validation, transform) always run. The 12 pipeline tests need a database
and **skip** without `SYNCDEMO_TEST_DATABASE_URL` — a skip is honest, a pass with nothing exercised
is not. They cover: all four stages advancing; the create call *not* pushing downstream; a stable
`employee_id` across systems; idempotency under repeated create and repeated poll; the duplicate
email refusal; each failure shape; retry after each; a stalled integration layer blocking
everything; the activity log containing every step; and the snapshot the dashboard renders.

They run against real Postgres in their own `syncdemo_test` schema, set by the `syncdemo` project's
`env` in `vitest.config.ts`. That is not decoration: `db.ts` reads the schema name once at module
load, and the test file's static imports pull it in before any hook runs, so setting it in
`beforeAll` left the suite in the default schema — the one a running dev server owns. Its 1.5s
poller then processed the tests' records and, because the fault switches are per-process, completed
pipelines the tests had deliberately broken. The failures moved between runs, which is what a race
looks like. `beforeAll` now asserts the schema so that cannot come back silently.

---

## 8. What is real and what is mocked

**Real in every mode.** PostgreSQL, including the schema, the landing table, the mapping, the
per-stage state, the activity log and the idempotency ledger. The dashboard's SSE transport. The
orchestration, retry and failure handling.

**Real when `SYNCDEMO_MODE=live`.**

- *BambooHR* — `BambooHRClient` against the live tenant. `createEmployee` creates a real person;
  `findByEmail` first, so a retry after an ambiguous create finds them instead of making a twin.
- *Striim* — a real Striim cluster over its REST API. In live mode this adapter **moves no data**.
  It reports the application's actual state and watches `public.bamboohr_employees`, the landing
  table the real BambooHR Reader writes. If a row is there, Striim put it there.
- *Workday* — Adaptive Planning, via the verified two-hop OAuth chain, writing a row to the
  `EUPTD - Employee Demographics` sheet.

**Mocked by default.** BambooHR, Striim and Workday, each backed by its own table so a record
genuinely travels between stores rather than a flag flipping on one row.

---

## 9. Known limitations

**Mock latency is not representative, and this is the big one.** Striim's BambooHR Reader is a
*polling* reader — BambooHR exposes no change feed, so there is nothing to tail — and the connector
enforces a floor: `PollingInterval: '30s'` is rejected with *"Please provide a valid value greater
than 300s for Polling Interval."* **Five minutes is the fastest a real BambooHR → Postgres Striim
pipeline can notice a new hire.** The mock's 1.5s poller uses the same mechanism (watermark, diff,
transform, land) pointed at a local table, so what you see is real change detection at an unreal
speed. The dashboard shows the mode and the interval so nobody is invited to believe otherwise.

**"Synced to Workday" means different things per mode.** The mock models what people picture: a
worker record store that assigns a `worker_id`. Adaptive Planning is not that — it is a planning
model where you write a value into a cell addressed by account × level × dimensions × period. In
live mode the employee's demographics are written to a sheet, with the metric cell set to **zero**,
because this demo has no pay figure and inventing one for a pay-equity model would be indefensible.
Stated in the UI rather than glossed over.

**The PostgreSQL fault is injected at the write, not by stopping the database.** The dashboard keeps
its own state in that database, so a genuinely stopped Postgres takes the whole app down instead of
showing a failed stage. The UI says so next to the toggle.

**Live Workday's count is what this process has written,** not the sheet's true size. Adaptive has
no cheap row count and an `exportData` round trip per dashboard refresh would be wasteful. The card
labels it "written this session".

**Live mode assumes one database.** The live Striim adapter reads `public.bamboohr_employees`, so
`SYNCDEMO_DATABASE_URL` has to point at the database the real Striim application writes to.

**No authentication.** It binds `0.0.0.0` so it works in Docker, and anyone who can reach the port
can create employees and toggle faults. Fine on a laptop; not fine on a shared network.

**Single process.** The poller and the fault switches are in-process. Two instances against one
schema would both poll and fight, which is what the separate test schema exists to avoid.
