# Striim spike — findings

2026-09-15 · Task 0 · **Verdict: GO**

Everything below was measured against Striim Cloud (`developer.striim.com`) and a live
Neon Postgres, not read from documentation. Where a finding contradicts the plan, the
measurement wins and the plan is corrected.

---

## Verdict

**GO**, on the Neon + Striim Cloud path rather than the local container.

Two applications (`sarah_moolai.InstantTeamsCDC`, `sarah_moolai.InstantTeamsInitialLoad`)
are deployed and were driven end to end: 200 employee rows bulk-loaded source to target in
under 15 seconds, and subsequent inserts and updates replicated live.

The local-container path was not attempted. The Cloud path was chosen because the
credentials are already proven, which removed the plan's single largest unknown
(whether a licence key exists) before it cost a day.

---

## What the plan got right

- The **CDC-before-bulk-load ordering**. The slot must be held first. Confirmed.
- **`send_ledger.id` is `bigserial`**, so the sequence advance is a real requirement.
- **`pending_approvals.detail` is `jsonb`**, and type fidelity was worth checking.
- The **REST calling convention** from the Striim agent repo's `FINDINGS.md` §1 —
  `POST /api/v2/tungsten`, `text/plain` body, `Authorization: token <value>` — works
  unchanged on Cloud. A JSON body still 415s.

## What the plan got wrong

### 1. `CREATE NAMESPACE IF NOT EXISTS` is a syntax error

Both TQL files in the plan open with it. Striim rejects it outright:

```
Syntax error at: CREATE NAMESPACE IF <mark>NOT</mark>OT EXISTS sarah_moolai;
```

The namespace is created once, out of band. The TQL only does `USE`.

### 2. `DEPLOY` is a separate step, and the runbook omits it

A freshly created application sits in `CREATED`. `START` on it fails with
*"Application is not deployed. Please deploy the application first"*.

### 3. There is no deployment group called `default`

`DEPLOY APPLICATION x;` fails with *"cannot find such deployment group: default"*. The
real name comes from `LIST DEPLOYMENTGROUPS;` — here, `sarah_moolai_dg` (3 servers).

### 4. Striim does not create the replication slot

The plan assumes the slot appears when the reader starts. It does not. The app goes
straight to HALT:

```
Specified slot is not created. Need appropriate replication slot to stream the changes
Cause: ERROR: replication slot "instant_teams_slot" does not exist
```

The slot is a prerequisite, created by us:
`SELECT pg_create_logical_replication_slot('instant_teams_slot','wal2json');`

### 5. A HALTed application refuses both STOP and START

The only way out is `RESUME`, or `UNDEPLOY` then `DEPLOY`. Any automation that drives
these apps has to know this or it deadlocks on first failure.

### 6. `postgresConfig` is missing from the plan's TQL — and without it there is no wal2json

Read off the working pipeline `sarah_moolai.sarah1_CDC`:

```
postgresConfig: '{"ReplicationPluginConfig":{"Name":"WAL2JSON","Format":"1"}}'
```

The plan's TQL names a slot but never says which plugin to speak.

### 7. The wal2json Docker image, the `striim` role, and Task 1 are unnecessary

Neon already provides everything the plan proposed to build:

| Setting | Value on Neon |
|---|---|
| `server_version` | **18.6** (the plan assumed 16) |
| `wal_level` | `logical` |
| `max_replication_slots` | 10 |
| `output_plugin_libraries` | `pgoutput, test_decoding, wal2json, wal2delta` |
| `neondb_owner` | has `REPLICATION` |

`output_plugin_libraries` already lists wal2json, so the PG-16.15+ concern the plan
raised is real but already handled by the platform. Creating a wal2json slot succeeds.

---

## The two findings that matter most

### A. UPDATEs silently do not replicate without `REPLICA IDENTITY FULL`

**This is the one that would have broken the demo on stage.**

With the default replica identity, measured on the live pipeline:

| Operation | Replicated? | Time |
|---|---|---|
| INSERT into `pending_approvals` (with `jsonb`) | yes | < 10 s |
| INSERT into `send_ledger` | yes | < 10 s |
| **UPDATE `pending_approvals SET status='approved'`** | **no** | never, 120 s observed |

No error. No rejected row. The application stayed `RUNNING` the whole time and every
status check passed. After `ALTER TABLE ... REPLICA IDENTITY FULL` on all four tables,
the identical UPDATE replicated **in under 10 seconds**.

An approval moving `pending -> approved` *is* an UPDATE. Without this, the migration
loses precisely the state this demo exists to prove it does not lose — and loses it
invisibly. It is now in `schema.sql`, with the reasoning, so it cannot be dropped by
someone recreating the database.

The plan's Task 0 Step 4 says "insert three rows on the source, confirm they arrive."
That test passes on a pipeline that silently discards every update.

### B. The application reports RUNNING about 15 seconds before the slot is actually held

Measured directly:

```
t+ 0s   app=RUNNING   slot_active=False  pid=None
t+15s   app=RUNNING   slot_active=True   pid=2489
```

The design gates "run initial load" on the CDC app reporting RUNNING. That gate opens
roughly 15 seconds too early, and the whole point of the ordering is that writes landing
before the slot is held are lost with no error.

**The gate must be `pg_replication_slots.active`, not the Striim app state.** That is a
direct read of the source, it is instant, and it is the actual precondition. Striim's own
`/health` additionally lags ~2 minutes (Striim agent `FINDINGS.md` §2), so app state is
the wrong signal twice over.

---

## Still open

- **The slot's `confirmed_flush_lsn` does not advance.** It sat at its creation value
  through the entire run while data replicated correctly. Data moves; the slot simply is
  not being confirmed, so WAL accumulates on the source and is never released. Harmless
  over a demo, not harmless over days. Not yet diagnosed.
- **The reader connects and disconnects on roughly a 30-second cycle** (`active` flips
  true/false). Replication works across it, so this looks like polling rather than a
  fault, but it means any "is CDC healthy?" check that samples `active` once can read
  false on a perfectly healthy pipeline. Sample over a window, or check LSN movement.
- **DELETEs were not tested.** Nothing in the application deletes from these tables
  today, so this is recorded rather than blocking.

---

## Verified configuration

Namespace `sarah_moolai`, deployment group `sarah_moolai_dg`.

| | |
|---|---|
| Source DB | `instant_ledger` on `ep-spring-mouse-axhfux81.c-4.us-east-2.aws.neon.tech:5432` |
| Target DB | `instant_ledger_target`, same host |
| Slot | `instant_teams_slot`, plugin `wal2json` |
| JDBC | `?sslmode=require&stringtype=unspecified` — `stringtype` is what carries `jsonb` |
| Tables | `;` between tables, `,` inside a `source,target` pair |

`jsonb` fidelity confirmed on the target: `pg_typeof(detail) = jsonb` and
`detail->>'packetId'` reads back correctly. No cast needed — `stringtype=unspecified`,
copied from the working pipeline, is what makes that true.
