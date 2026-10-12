# synthdata-rockfish — the canonical `employees.json` producer

**`@lifespan THROWAWAY` · run once.** A dev-time Python tool that mints the one
durable artifact `employees.json` (~200 realistic-but-fake employees) and drops
it into `../../fixtures/employees.json`, the data contract the TS MVP consumes.

- **Not imported by the runtime.** The MVP reads only the committed JSON via
  `loadDemoEmployees()`. Rockfish, pandas, and this whole directory stay off the
  prod VM. Lives outside `src/`, invisible to the TS toolchain and the
  `depcruise` isolation rail.
- **No git.** This workstream performs no git action. Delivery is a plain file
  copy of `employees.json` into `../../fixtures/`.

See [`spec.md`](../../../agent-os/specs/2026-08-18-instant-teams-synthetic-data-rockfish/spec.md)
and its [implementation plan](../../../agent-os/specs/2026-08-18-instant-teams-synthetic-data-rockfish/implementation-plan.md)
for the full design (contract, the Rockfish/pandas split, the verified 0.68.0 API).

## What it produces

An array of `EmployeeRecord` (11 required camelCase keys + optional
`priorCostCenter`; dates `YYYY-MM-DD`). Codes are frozen verbatim:
`RFT/RPT/SNL`, `A/L/T`, `CC-RETAIL/CC-OPS/CC-CX/CC-ENG`.

- **Rockfish 0.68.0** generates the independent columns and realistic names
  (`employee_id`, `first_name`/`last_name` via `NAMED_ENTITY_PROVIDER`,
  `employee_type`, the two flags, `age_years`) via a managed cloud job.
- A seeded **pandas** pass (`finish.py`) adds the type→`status`/`costCenter`/
  `tenure` correlations (no installable Rockfish has `CONDITIONAL_SAMPLE`) plus
  the four derived fields (`email`, dates, `phone`, `priorCostCenter`), and
  provides a per-cell curated **name fallback** for the provider's server-gating
  risk.

## Setup

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -U -r requirements.txt
cp .env.example .env   # then fill in ROCKFISH_API_KEY and ROCKFISH_ORG_ID
```

## Run

```bash
python check.py       # (live) prove the credentials work
python generate.py    # (live) smoke the schema-only workflow + the name-smoke
python main.py        # (live) mint employees.json, gated on find_violations + assert_quality
cp employees.json ../../fixtures/employees.json    # deliver — no git
cd ../.. && npm test -- fixture                     # cross-artifact acceptance (the real proof)
```

## Test (offline — no Rockfish key needed)

```bash
pytest -q             # 13 tests: finishing pass (names/patterns/derived) + the validity gate
```

`finish.py`/`validate.py` are pure pandas/stdlib and fully TDD'd offline against
a fabricated Rockfish-shaped DataFrame, so the single live run is never spent
debugging logic.
