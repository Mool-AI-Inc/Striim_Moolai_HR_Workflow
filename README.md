# Instant Teams MVP

Single-tenant People-Ops automation: a **generic Temporal host** (ingress / scheduler / worker) plus **plug-in use-case modules**. The host knows nothing about any use case — it derives its whole trigger / activity / schedule surface from one module list.

## What runs today — nine use cases, seven plug-in modules

The full system is live. The New-Hire Arc (Plan 2) plus the recurring-records set (Plan 3) were consolidated onto this trunk with **zero platform change** — four module folders + four registry lines (see [`docs/design/2026-08-24-branch-integration-notes.md`](docs/design/2026-08-24-branch-integration-notes.md)).

| UC | What | Trigger | HITL? |
|----|------|---------|-------|
| UC1  | Welcome email on new-hire | `employee.new-hire` | — |
| UC7  | Consent-gated welcome **SMS** | `employee.new-hire` | — |
| UC2a | Hire-anchored **Day-60** compliance notice (+ did-not-send alarm) | `employee.new-hire` | — |
| UC2b | Day-60 **benefits** (Employee Navigator) send | `employee.new-hire` | ✅ human confirm |
| UC6  | Onboarding-**packet** recommendation + assignment | `employee.new-hire` | ✅ human confirm |
| UC3  | **Personnel-file** checklist (background check + I-9 → Drive) | `employee.task-complete` | ✅ human confirm |
| UC5  | **Birthday / anniversary** greetings | daily schedule | — |
| UC8  | **Starting-soon** Slack channel invites | daily schedule | — |
| UC4  | **Monthly finance report** (new-hire cost centers, transitions flagged) | monthly schedule | ✅ human confirm |

Seven modules under [`src/usecases/`](src/usecases/): `newHireLifecycle`, `packetSelection`, `benefitsDay60Send` (Plan 2) + `personnelFile`, `birthdayAnniversaryScan`, `startingSoonScan`, `monthlyFinanceReport` (Plan 3).

## Modularity invariant

Enabling a use case is **two lines**:

1. one entry in [`src/platform/registry.ts`](src/platform/registry.ts) (`MODULES`)
2. one `export *` in [`src/platform/workflows.bundle.ts`](src/platform/workflows.bundle.ts)

The platform never changes. Removing a use case is deleting those lines. Proof: [`test/ingress/endToEnd.test.ts`](test/ingress/endToEnd.test.ts) asserts, over the real registry, that `employee.new-hire` fans out to exactly the registered modules, that unconsumed events / schedules start **nothing**, and that dropping a module's line removes its activities — with no platform edit.

## One switch: demo vs live

[`src/platform/config/env.ts`](src/platform/config/env.ts) reads `PLATFORM_MODE`:

- **`demo`** (default) — every vendor base URL is the simulator; credentials are throwaway.
- **`live`** — each base URL + credential comes from its own env var (required, fail-fast if missing).

Cutover = flip the flag + supply credentials. No code change.

## Human-in-the-loop approvals

HITL is a **Temporal Workflow Update** (`decideUpdate`), never a Signal.

- **Approval API** ([`src/platform/approval-api/approvalServer.ts`](src/platform/approval-api/approvalServer.ts)) — `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/decision` → `executeUpdate(decideUpdate)`. Reads the inbox from the DB (`pending_approvals`), not a Query fan-out. A rejected/already-decided/empty-reason decision → `409`.
- **Approval app** ([`src/platform/approval-app/`](src/platform/approval-app/)) — React + Vite SPA, **WCAG 2.1 AA** (semantic list, real `<button>`s, labeled reason `<textarea>`, Approve/Reject disabled until a reason is typed, `aria-live` status). Renders **all four** approval kinds (the two Plan-3 kinds render now, so Plan 3 needs zero UI rework). Point `VITE_APPROVAL_API` at the API.
- **Slack fallback** ([`src/platform/approval-api/slackInteractions.ts`](src/platform/approval-api/slackInteractions.ts)) — `POST /webhooks/slack/interactions`, HMAC-verified (`v0:timestamp:body`; bad/short signature → `401`), Block Kit Approve/Reject → the **same** Update.

## RPA stand-in

UC6 packet-assign and UC2b EN-send write through a **file-drop connector** (the simulator's `/packets/:id/assign` and `/en/:id/send`) in **both** modes. The production Playwright robot runner is not built here.

## Tests — four tiers

| Command | Tier | Needs Postgres? |
|---------|------|-----------------|
| `npm test`             | unit (offline) | no |
| `npm run test:ui`      | approval app (jsdom + React Testing Library) | no |
| `npm run test:temporal`| all workflows (UC3/4/5/8 + Plan-2) + approval-spine, in-process Temporal test server | yes for the ledger-backed workflows (UC3 personnel-file, UC4 finance report, `awaitApproval` spine); no for UC5/UC8 + approval-API/Slack (in-memory) |
| `npm run test:integration` | ledger + personnelFile activities | yes (`app-postgres`) |

All tiers green (2026-08-24): `tsc` **0** · unit **85** · ui **4** · temporal **36** · integration **4** · isolation **clean** (96 modules). Static gates: `npm run typecheck`, `npm run lint:isolation`.

## Getting started

**Prerequisites:** Node ≥ 20 and npm. Docker is needed **only** for the Postgres-backed test tiers and the VM runtime (below) — the interactive demo needs neither.

```bash
npm install
cp .env.example .env
```

`.env` is gitignored and never leaves your machine. **Demo mode needs nothing in it** — every vendor URL points at the bundled simulator. For `live` mode, fill in your own credentials (see [`.env.example`](.env.example)) and set `PLATFORM_MODE=live`.

## Employee sync demo — BambooHR → Striim → PostgreSQL → Workday (`npm run syncdemo`)

A separate, self-contained dashboard that shows one employee record travelling across four systems,
with every status on screen read from Postgres rather than from a timer. Runs fully mocked with no
configuration; `SYNCDEMO_MODE=live` points it at the real BambooHR, Striim and Workday.

```bash
npm run syncdemo                                      # → http://localhost:3000
docker compose -f docker-compose.syncdemo.yml up      # or fully containerised
npm run syncdemo:test                                 # 20 tests over the sync path
```

Full architecture, data flow, env vars and limitations: **[src/syncdemo/README.md](src/syncdemo/README.md)**.

## Interactive demo — the click-through UI (`npm run interactive`)

The hands-on way to explore the whole system: an employee picker, a settable clock for the 60-day wait, live human approvals, the recurring scans, and (optionally) real email. It runs the entire platform **in-process** on a time-skipping Temporal env — **no Docker, no Postgres** (all state is in-memory).

```bash
npm run interactive
# ✅ Interactive demo UP.  API http://127.0.0.1:8090   (simulator on :8085)
```

Or bring up everything — API, UI and the BambooHR watcher — with one command, started in
dependency order so the UI never loads before the API is listening:

```bash
npm run up              # add -- --no-hris to leave the BambooHR watcher off
```

To start the UI on its own instead, in a second terminal (no env var needed — `vite.config.ts`
proxies to `127.0.0.1:8090` by default):

```bash
npm run ui:dev
```

In the browser you can:

- **Pick a new hire** → watch the onboarding journey unfold (UC1/UC7 welcome, UC6 packet, UC2a/UC2b Day-60).
- **Advance the clock** (+7 days, or straight to Day 60) to mature the durable Day-60 timer instantly.
- **Approve / reject** each human-in-the-loop step — packet (UC6), benefits (UC2b), personnel-file (UC3), finance-report (UC4) — with a reason.
- **Run daily scans** → the recurring UCs fire over a seeded population: UC5 birthday/anniversary greetings, UC8 Slack channel invites, and the UC4 monthly finance report (open it in-browser via the **view report** link — cost-center transitions highlighted).

**Email is offline by default** — sends are logged to the console. To send **real** mail via Microsoft Graph, add the Graph block to `.env` (copy [`.env.example`](.env.example)): `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `SENDER_EMAIL`. Every demo email is redirected to `DEMO_EMAIL_TO` (default `sarahm@moolai.ai`), so the fake fixture addresses are never contacted.

## Scripted demo — `npm run demo`

Composes the whole system **in-process** on a time-skipping Temporal env, so the clock is a dial and the worker is killable.

```bash
docker compose --profile runtime up -d app-postgres   # the ledger (pending_approvals + send_ledger)
npm run demo
```

- Simulator seeded with **"Dana"** (consenting, hired **today** → her Day-60 timer is in the future) plus the committed fixture, bound to the `SIMULATOR_URL` port (default `:8085` — the worker's connectors capture that URL at import, so the sim binds to it; don't run `npm run simulator` on the same port alongside).
- **Time-skipping** = the clock dial (matures the durable Day-60 timer instantly) **and** durable across a worker kill/restart (its server holds all workflow + inbox state). It is **dev/demo-only** — the VM runtime uses the compose `temporal` (`start-dev`) service.

### Presenter runbook (the Dana beats)

1. New-hire webhook fires → **welcome email** + **welcome SMS** land (UC1 / UC7).
2. A **packet recommendation** appears in the approval inbox → approve → **assignment receipt** (UC6).
3. The **Day-60 timer** matures (time-skip) → **compliance email** (UC2a).
4. A **benefits send** appears in the inbox → approve → **EN send receipt** (UC2b).
5. **Worker kill/restart** → inboxes + pending state persist (durability).

Receipts printed from the simulator inboxes: `/_sent`, `/_sms`, `/_assignments`, `/_ensends`.

## Runtime (Ubuntu / Azure)

```bash
docker compose --profile runtime up -d    # app-postgres (:5433) + temporal (start-dev)
```

Target VM: Azure **B2ms** (2 vCPU / 8 GB). **Single-tenant** — one instance per org.

### Prod-cutover notes

- **Approval API auth:** the API has **no reviewer auth** in the MVP — `approver` is a stub from the request body and there is no per-kind authz (spec §H defers SSO). At cutover, add a Fastify `preHandler` that authenticates the reviewer and derive `approver` from the authenticated principal, not the body. Today the API only runs ephemerally inside `npm run demo`; the day a long-lived entrypoint ships (§F8), **do not expose the decision route unauthenticated** — until SSO lands, bind the listener to loopback and front it with a network-level auth proxy.
- **SMS (UC7):** register a 10DLC campaign + capture real consent before live SMS.
- **Slack:** a real Slack app + signing secret (interactivity needs a paid plan) for the fallback.
- **Credentials:** real Paylocity / Postmark / Anthropic keys via the `live` env vars.
