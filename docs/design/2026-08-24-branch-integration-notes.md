# Branch consolidation — `amogh-code` → `main` (integration notes / ADR)

**Date:** 2026-08-24 · **Status:** Verified green on `integrate/plan3`; consolidated into `main`.
**Spec:** `agent-os/specs/2026-08-24-instant-teams-branch-consolidation/{spec.md, implementation-plan.md}`.

## Context

Two independent full implementations branched from the same Plan-0 foundation (`495f91e`):
- **`main` (`6bd93a4`, ours)** — the five-UC New-Hire Arc (UC1/UC2a/UC2b/UC6/UC7) plus native Graph email, the interactive click-through demo, and the UC6 doc-picker/email + enriched decision table.
- **`origin/amogh-code` (`f5943fd`)** — a committed all-nine-UC build, but with Plan-2 modules named off-plan and a parallel approval-app/DB layer.

A three-way `git merge` was rejected: it would produce add/add conflicts on every shared file **and** duplicate modules (two UC1s, two UC2bs). See spec §F.

## Decision

**Keep our `main` as the trunk; graft only the coworker's four Plan-3 modules onto it.** The end-state module registry equals the master plan's canonical seven.

- **Grafted (net-new folders, from `origin/amogh-code`):** `personnelFile` (UC3), `monthlyFinanceReport` (UC4), `birthdayAnniversaryScan` (UC5), `startingSoonScan` (UC8) — plus their fixtures-independent tests.
- **Dropped:** their Plan-2 duplicates (`newHireOnboarding`, `enBenefitsSend`, their `packetSelection`), their `src/approval-app/**`, and any platform/DB file ours already provides.
- **Retained for provenance:** `origin/amogh-code` is left on the remote as an archive; never mutated.

**Why ours is the trunk:** our Plan-2 module names match the design plans (theirs deviate), and our Graph email + interactive demo + UC6 work would otherwise need re-porting.

**Why the graft is clean:** both branches share the frozen Plan-0 contract. Verified 2026-08-24 that every symbol the four modules import already exists on `main`; the only two platform files that differ (`domain/types.ts`, `connectors/types.ts`) differ **solely** by our UC6 superset additions, which the grafted modules never import. So the graft needed **zero platform-contract edits** — matching the master plan's "+4 registry lines" promise.

## What changed on `main`'s side (beyond the graft)

- **Registry wiring:** `registry.ts` + `workflows.bundle.ts` gain the four modules → the canonical seven. The grafted modules export `<name>Module` (not `module` like our Plan-2 files), so the registry imports alias them (e.g. `birthdayAnniversaryScanModule as birthdayAnniversaryScan`). `mergeActivities` stays collision-free (full activity set verified pairwise-distinct).
- **Email templates:** the shared `emailTemplates.ts` gained three additive templates the grafted modules render — `birthday`, `anniversary` (UC5), and `uc4-report-ready` (UC4). Additive keys only (no type/contract change; typecheck + isolation clean). Note: the spec's pre-graft audit listed these as already present on `main`; they were not, so they were added here — the one platform edit beyond the "+4 registry lines" promise.
- **UC5 leap-day fix:** the `02-29 → 02-28` non-leap-year normalization was mirrored onto the anniversary branch of `birthdayAnniversaryScan/selectors.ts` (it was applied to birthdays only). A leap-day *hire* now gets an anniversary email on Feb-28 in non-leap years. The one audited defect from the Plan-3 review.
- **`registry.test.ts` / `endToEnd.test.ts`:** updated their pre-integration assertions (which encoded "exactly three modules" / "Plan-3 consumers absent") to the integrated reality.

## Strategy reconciliations (§S)

- **§S1 — one document strategy.** This repo generates documents dynamically (`simulator/documentGenerator.ts`, 28 kinds) rather than serving static committed PDFs. Plan-3's `fixtures/docs/*.pdf` were **not** grafted; the two UC3 connector tests that read static files were adapted to assert the dynamic generator's contract (valid `%PDF-` header + non-empty). No static fixtures reintroduced.
- **§S2 — packets.** Our `packetSelection` (enriched decision table + `fixtures/packets/index.json`) is canonical; it stays matched with the 28-doc generator. The four Plan-3 modules do not touch packets.
- **§S3 — demo coverage / UC4 Sheets route.** The `EmployeeRecord` contract is unchanged. The recurring scans (UC4/5/8) are `schedule`-triggered in prod but the interactive demo is event-driven, so a demo-only trigger was added (below). UC4's demo path (`SheetsReportSink` → simulator) needed the `/v4/spreadsheets/*` route, which was ported from `origin/amogh-code` into our simulator.

## Demo wiring (Task 6, THROWAWAY layer)

`POST /scans/run` on the interactive server seeds guaranteed actors (birthday-today, anniversary-today, starts-tomorrow, a this-month cost-center transfer) alongside the fixture + any active hire, starts the three scan workflows, and returns their results. A **"Run daily scans"** button in the approval app surfaces them. Verified end-to-end in a browser: UC5 birthday + anniversary emails, UC8 Slack invite, UC4 finance report (3 hires, 1 transition) + a `finance-report` approval.

The demo also overrides the `writeFinanceReport` activity to keep the report rows in memory and return a **local** `/reports/:name` URL that renders them as an HTML table (cost-center transitions highlighted) — so the reviewer can open the report in-browser instead of a Google Sheet they have no access to. The production `SheetsReportSink` (real Google Sheets URL) is unchanged.

## Verification (2026-08-24)

Green on `integrate/plan3` (Postgres up): `tsc --noEmit` **0 errors** · unit **85/85** · ui **4/4** · temporal **36/36** (UC3/4/5/8) · integration **4/4** (ledger + personnelFile) · isolation **clean** (96 modules). Total **129** tests passing.

The Postgres-backed tiers (temporal UC3/UC4 + integration personnelFile/ledger) were run green on 2026-08-24 via `docker compose --profile runtime up -d app-postgres`.

## Not in scope (YAGNI)

Their Plan-2 modules, their approval-app/platform/DB duplicates, any `EmployeeRecord`/schema change, the Playwright RPA runner (UC6/UC2b keep the file-drop stand-in), real SSO / per-reviewer Slack authz. `origin/amogh-code` kept as archive.
