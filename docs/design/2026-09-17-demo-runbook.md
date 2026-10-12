# Demo runbook — live database migration under a running agentic platform

The claim, in one sentence:

> **Your agentic automation does not have to stop for a database migration, and nothing it
> already did gets lost or repeated.**

Everything is a button. Nothing is scripted, timed, or pre-recorded. You can run the beats
in any order, repeat them, or skip them.

---

## Before you start (5 minutes)

**One terminal**, in `C:\Users\madha\Downloads\instant_teams_mvp 2`:

```
npm run up
```

That starts all three processes in the order they actually depend on each other — API and
simulator, then the UI once port 8090 answers, then the BambooHR watcher. Starting the UI
first is what produces the "Couldn't reach the demo API" page: Vite proxies to 8090 and
serves its own index.html when nothing is listening, so the error blames the API when the
API is merely not up yet. `npm run up` waits, so that cannot happen.

- `npm run up -- --no-hris` leaves the watcher off. Use it for the migration beats: the
  watcher re-touches every BambooHR row every 30s, so the panel's checksums flicker while
  replication catches up. Nothing is wrong, but it looks unsettled.
- press **h** while it runs to stop or start just the watcher; **q** or Ctrl-C stops everything.

<details><summary>the old two-terminal way, if you need the processes separate</summary>

```
npm run interactive
npm run ui:dev          # no env var needed; vite.config.ts defaults to 127.0.0.1:8090
npm run watch:bamboohr
```
</details>

Wait for `[ledger] pg mode — approvals and the send ledger are in Postgres (10 employees)`.
If it does not say **pg mode**, the ledger is in memory and the whole demo is pointless —
check `LEDGER_MODE=pg` in `.env`.

It says **10**, not 200: the picker shows only people the live BambooHR tenant lists
(`ROSTER_SOURCE=bamboohr`, `ROSTER_LIMIT=10`, newest first). The 201 synthetic `EMP_*` rows are
still in the table — they are most of the bulk the migration moves — they are just not offered
in the dropdown. `ROSTER_SOURCE=all` shows everything again.

Open **http://localhost:5173**. Press **Reset** in the migration panel. You want:

| | |
|---|---|
| Source | employees 200, everything else 0 |
| Target | all zeros |
| CDC | STOPPED |
| Slot | not created |

Have a second tab on **https://developer.striim.com** → namespace `sarah_moolai`, so you
can show the pipelines are real.

---

## The beats

### 1. "Here is the platform doing its job." (90 seconds)

Pick a new hire from the dropdown. The onboarding arc runs: welcome email, packet
recommendation lands in the approval inbox.

**Say:** *Nine agentic People-Ops workflows, all running against one Postgres database.
Every send is written to a ledger, every human decision is a row. That ledger is what we
are about to move — underneath the running system.*

Point at the panel: `send_ledger` and `pending_approvals` on the source have just ticked
up from 0. **Those numbers are the workflow you just ran.**

### 2. "Start the change stream." (60 seconds)

Press **1 · Start CDC**.

**Say:** *Striim is now tailing the write-ahead log. Notice what I cannot do yet.*

Point at button 2 — disabled, with the reason printed underneath:
*"waiting for Striim to actually hold the slot (the app reports RUNNING first)."*

**This is the best thirty seconds of the demo. Do not rush it.**

**Say:** *Striim says this pipeline is RUNNING. It is not, quite. We measured a gap of up
to thirty seconds between the application reporting RUNNING and the replication slot
actually being held. If you start the bulk copy inside that window, every write that lands
in it is lost — and nothing anywhere tells you. No alert, no error, no failed row. So this
button does not trust the status. It reads the replication slot on the source database
directly, and it stays disabled until the slot is genuinely held.*

Wait for it to enable.

### 3. "Copy the history." (60 seconds)

Press **2 · Run initial load**. Watch the target column fill: 0 → 100 → 200.

**Say:** *CDC first, bulk load second — never the other way round. The slot has to be
holding the log position before the bulk read starts, or the window between them is a hole.*

When it settles, all four tables show `match`.

**Say:** *That is not just row counts. It is a checksum over every row on both sides. A
matched row count survives a surprising amount of corruption — we have seen this platform
report nine thousand nine hundred records in and nine thousand nine hundred out against a
table holding about nineteen hundred. So we check the contents, not the tally.*

### 4. "Move the database. Without stopping." (90 seconds)

Press **3 · Cut over**. Five steps appear:

```
quiesce             new workflow starts refused
drain               row counts and checksums match on every table
stop-cdc            CDC is STOPPED
advance-sequences   public.send_ledger_id_seq -> 1
flip                application is now writing to the target
```

**Say, on `stop-cdc`:** *This one is non-negotiable and it has to happen before the flip.
The moment the application starts writing to the target, a CDC pipeline still running is
replicating into the new primary. That is split brain, and it is silent. If we cannot
confirm CDC has stopped — including if we simply cannot tell — this refuses to flip.*

**Say, on `advance-sequences`:** *Change capture copies the value of an auto-increment
column. It never copies the position of the sequence behind it. So the target's sequence is
still at one, and the first insert after the move collides on the primary key. That
failure shows up as the very first thing anyone does after the migration, which is the
worst possible moment to find it. We do it here instead.*

**Say, on `flip`:** *No process restart. No worker shutdown. No dropped Temporal tasks. The
connection pool is rebuilt lazily from an environment variable, so repointing it and
closing the pool is the entire cutover. The workflows never noticed.*

The Source card loses its "live" marker. The Target card gains it.

### 5. "Prove nothing was lost or repeated." (2 minutes — the one that matters)

**Say:** *Counts and checksums are a DBA's evidence. Here is the business's evidence.*

In a terminal:

```
curl -s -X POST http://127.0.0.1:8090/migration/proof -H "content-type: application/json" -d "{}"
```

```json
{
  "readingDatabase": ".../instant_ledger_target",
  "idempotencyKey": "welcome:EMP_0-r1",
  "skipped": true,
  "ledgerRowsBefore": 1,
  "ledgerRowsAfter": 1
}
```

**Say:** *That replayed a send the OLD database recorded, through the real production
activity, against the NEW database. It checked the ledger, found the key, and declined to
send. Row count unchanged.*

*If the ledger had migrated unfaithfully — one missing row, one truncated key — a real
person gets a second copy of their welcome email. That is the same assertion this platform
makes every day in production, and it still holds across a live database migration.*

### 6. "And it is repeatable." (30 seconds)

Press **Reset**, then run it again. Or do not — but say it:

**Say:** *A demo you cannot re-run is a demo you cannot rehearse.*

---

## Questions you will get

**"Is Striim actually doing this, or is it a mock?"**
Open the Striim tab. `sarah_moolai.InstantTeamsCDC` and `InstantTeamsInitialLoad`, with
throughput. The TQL is in `striim/`. Both databases are real Neon Postgres.

**"What about Temporal's own state?"**
Not migrated, deliberately. Temporal owns *where the workflow is*; Postgres owns *what the
business recorded*. Moving the second does not disturb the first — which is exactly why the
workflows keep running through the cutover.

**"What happens if the cutover goes wrong?"**
It refuses and puts things back. It will not flip if the drain has not converged, if CDC is
still running, or if it cannot tell what CDC is doing. Every refusal re-opens workflow
starts, so a refused cutover leaves the platform exactly as usable as it was before. There
are eight tests that assert things did NOT happen.

**"How long would this take on a real database?"**
The bulk load scales with data; the cutover window is the drain plus a few seconds. The
drain is a poll on real evidence, not a timer — it blocks until both sides agree.

**"What did you find out about Striim that you didn't expect?"**
The honest, strong answer: *Six things in the plan were wrong, and we only know because we
ran it.* `CREATE NAMESPACE IF NOT EXISTS` is a syntax error. DEPLOY is a separate step from
START. There is no deployment group called `default`. Striim does not create the
replication slot — it HALTs if you assume it does. A HALTed application refuses both STOP
and START; only RESUME works. And without `postgresConfig` naming wal2json, you get no
wal2json whatever the slot says.

**And the one that would have broken this demo on stage:** without
`REPLICA IDENTITY FULL` on the source tables, INSERTs replicate and **UPDATEs silently do
not**. Measured: inserts arrived in under ten seconds, updates never arrived at all, no
error, pipeline still green. An approval going pending → approved is an UPDATE. The
standard spike — "insert three rows, confirm they arrive" — passes on a pipeline that
throws away every approval decision.

---

## If it breaks

| Symptom | Fix |
|---|---|
| Page will not load | Check both terminals. `npm run interactive` must say **pg mode**. |
| Port in use | `Get-NetTCPConnection -LocalPort 8090 -State Listen` → `Stop-Process -Id <PID> -Force`. Also kill any `temporal-test-server-*` process. |
| "Failed to start ephemeral server: Access is denied" | An orphaned `temporal-test-server-*` process holds the binary. Kill it and restart. |
| Button 2 never enables | The slot is not being held. Check CDC in the Striim UI; press Reset and start again. |
| Cutover refuses at `drain` | Source and target disagree. Press Reconcile to see which table. Usually CDC is not actually streaming — check the slot. |
| Everything is confused | Press **Reset**. It truncates the target, drops the slot, and stops both pipelines. |

**The fallback if Striim is unreachable on the day:** the migration panel reads both
databases directly, so row counts and the reconcile still work and still tell the story.
You lose beats 2 and 3, not the proof in beat 5.

---

## What to leave them with

*Striim reliably tells you what it did. Nothing tells you what actually ended up in your
database. We built the thing that checks — and then we moved a live database underneath
nine running agentic workflows without stopping them, and proved we had not lost or
duplicated a single record.*
