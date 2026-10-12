# Demo guide — two HRIS pipelines

Two independent pipelines, two ports, either can carry the demo on its own.

| | **:3000 forward** | **:3001 reverse** |
|---|---|---|
| Route | BambooHR → Striim → PostgreSQL → Workday | Workday → PostgreSQL → BambooHR |
| BambooHR | **LIVE** (source) | **LIVE** (target — creates real people) |
| Striim | **LIVE** — the real app does a real leg | **not involved** — no adapter exists for either end |
| PostgreSQL | **LIVE** | **LIVE** |
| Workday | **mocked** — the 20 slots don't exist yet | **LIVE** (read-only) |

**Neither has all four live.** :3000 has real Striim but a mocked Workday; :3001 has a real Workday and real BambooHR but no Striim. Pick based on what the room cares about — Striim, or Workday.

---

## Part 1 — Before you start (5 minutes)

### 1.1 Start the services

One terminal each, in `C:\Users\madha\Downloads\instant_teams_mvp 2`:

```powershell
npm run syncdemo        # :3000 forward
npm run reversedemo     # :3001 reverse
npm run watch:bamboohr  # only if you'll use the Instant Teams app on :5173
```

Check what's already up before starting anything — these have been killed for memory before:

```powershell
foreach ($p in 3000,3001,5173,8090) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { "port $p UP" } else { "port $p DOWN" }
}
```

### 1.2 Open four tabs

| Tab | URL | Login |
|---|---|---|
| Forward dashboard | http://localhost:3000 | — |
| Reverse dashboard | http://localhost:3001 | — |
| **BambooHR** | https://trialea7f941c.bamboohr.com/app/employees/directory | your trial login |
| **Striim console** | https://developer.striim.com | `STRIIM_USER` from `.env` |

In the Striim console, navigate to namespace **`sarah_moolai`** and open **`BambooHRToPostgres`**. Leave it on screen — that is your proof Striim is real.

> There is no verified Adaptive **UI** URL. It isn't recorded in either repo — only API endpoints. Workday evidence is shown through the API and the database instead (§4.3).

### 1.3 Preflight

```powershell
npm run slots:check        # are the 20 Adaptive members there?
npm run show:db -- striim  # what Striim has actually written
```

Expected today: `slots:check` reports **MISSING: 20**, and `show:db` shows **90 rows** landed by Striim.

Then on :3000 press **Reset demo** — the log should say *"90 pre-existing employees re-baselined"*. That guard stops your existing workforce replaying as 90 new hires.

---

## Part 2 — Forward demo (:3000) — "BambooHR is the source of truth"

### Beat 1 — the systems are real (30s)

Show the four cards. BambooHR reads **109** live from the API; Striim reads **RUNNING** from the cluster.

> *"Four systems. Every number here is read from the system it names — BambooHR over its REST API, Striim over its REST API, Postgres directly."*

### Beat 2 — create the employee **in BambooHR** (1 min)

Go to the BambooHR tab and add a person. Fill in:

**first name, last name, work email, hire date, date of birth, job title, department, location, and a pay rate.**

> Hire date and date of birth are required by the Instant Teams dropdown (Day-60 timer, birthday scan). The **pay rate** is the figure that reaches Workday — `PY Pay` is the only writable column on that sheet, so without it the Workday stage stops rather than writing a zero over a real number.

> *"I'm not typing into my own app. This is BambooHR."*

### Beat 3 — Striim picks it up (15s, or up to 5 min)

**Striim's BambooHR reader is floored at 300 seconds** — the connector rejects anything faster. Two options:

- Press **Force Striim read** on the dashboard. It stops and starts the real Striim application, which bulk-reads on start. ~15s.
- Or add the person before Beat 1 and let the five minutes pass while you talk.

> *"Striim polls BambooHR — there's no change feed to tail, and the minimum interval the connector allows is five minutes. I'm restarting the app to force its bulk read."*

### Beat 4 — show it in Striim (30s) ← **the bit people ask for**

Three places, strongest last:

1. **Dashboard Striim card** — pipeline state, events processed, landing-table row count.
2. **Striim console tab** — `sarah_moolai.BambooHRToPostgres` is RUNNING. Point at it.
3. **The table Striim wrote**, in a terminal:

```powershell
npm run show:db -- striim
```

> *"`public.bamboohr_employees` — nothing in my codebase writes this table. Striim's DatabaseWriter created it and owns it. If a row is there, Striim put it there."*

### Beat 5 — PostgreSQL and the slot (1 min)

Watch the pipeline panel: **PostgreSQL ✓**, then **Searching for an available slot** → **EMP_9001 claimed** → **Workday ✓**, with `Slot: EMP_9001` on the node. The **Slot Monitor** shows all 20 with one now taken.

```powershell
npm run show:db -- forward
```

> *"The employee id is the correlation key and it's identical in all four systems. The mapping to the Adaptive member is a row in Postgres, so it survives a restart."*

### Beat 6 — failure and recovery (optional, 1 min)

**Failure simulation** → tick *Workday sync fails* → create one from the dashboard form. The pipeline stops at Workday, the log gives the reason, **Retry** appears. Untick, retry, it completes — reusing the same slot, no duplicate.

### What to say about Workday on :3000

> *"The Workday leg writes to a local target today. Adaptive Planning's dimensions are pre-enumerated — you can update an existing member but you cannot create one through the import API — so we pre-allocate twenty empty members and the pipeline claims one per hire. Those twenty are being created by our Adaptive admin; the integration is written against the real API and authenticates against it."*

If asked whether a real write has ever succeeded: **yes** — `Adaptive rows updated: 1`, using the minimal row shape, the internal level code, and an existing member.

---

## Part 3 — Reverse demo (:3001) — "Workday → BambooHR migration"

Use this when the room cares about Workday being real, or if :3000's Striim app is down.

### Beat 1 — Workday is the source (30s)

The Workday card shows **249 members read live** from the Adaptive sheet. The dropdown lists them with real names, locations and pay.

> *"This is a live `exportData` against our Workday Adaptive tenant — 249 people, with their locations and pay rates."*

### Beat 2 — pick a person and import (1 min)

**Read the red banner first.** When BambooHR is live, an import creates a **real, permanent** employee — that API has no delete, only termination, and each create consumes a seat.

Pick someone from the dropdown → **Import selected into BambooHR** → confirm the dialog.

Watch: **Workday ✓ → Striim (transform) ✓ → PostgreSQL ✓ → BambooHR ✓** with the new BambooHR id on the node.

### Beat 3 — show it in BambooHR (30s)

Refresh the BambooHR directory tab. **The person from Workday is now in BambooHR.** Their email is synthesised — `jan.wilmer.emp.0019@workday-import.example.com` — because Adaptive carries no email and BambooHR requires a unique one.

```powershell
npm run show:db -- reverse
```

Shows all three tables: what came out of Workday, the mapped record, and the Workday-member → BambooHR-employee mapping.

### Beat 4 — idempotency (30s)

Press Import again for the same person. It completes but reports **matched, not created** — one person, one BambooHR record. The mapping is keyed on the Workday member id and reserved *before* the HRIS call, so even a crash mid-create can't produce a twin.

### What to say about Striim on :3001

Be straight about it:

> *"On this direction Striim isn't in the path. It has 364 adapters — the only Workday one reads Workday HCM, not Adaptive Planning — and of its 50 writers, none is an HR system. So for Workday-to-BambooHR, Striim could only sit between two Postgres databases. That's why the Striim-led story is the other pipeline."*

Don't claim Striim is doing this leg. The card says `mock` on screen and someone will read it.

---

## Part 4 — Showing the data in each platform

### 4.1 BambooHR
The directory tab: https://trialea7f941c.bamboohr.com/app/employees/directory — refresh after any import.

### 4.2 Striim
The console at https://developer.striim.com → namespace `sarah_moolai` → `BambooHRToPostgres`. Plus `npm run show:db -- striim` for the table it writes, and:

```powershell
python striim/deploy.py status
```

### 4.3 Workday / Adaptive
No verified UI URL, so use the API-level evidence:

```powershell
npm run slots:check   # authenticates, exports the sheet, lists which members exist
```

It proves the credentials work and reports the 530 members on the sheet. The sheet is **EUPTD - Employee Demographics**, instance `PART_20251031_BH9`, version *Pay Transparency v1*.

### 4.4 PostgreSQL
`psql` is not installed, so:

```powershell
npm run show:db              # both pipelines
npm run show:db -- forward
npm run show:db -- reverse
npm run show:db -- striim
```

---

## Part 5 — Troubleshooting

| Symptom | Fix |
|---|---|
| New BambooHR employee never appears | Hire date or DOB blank. The dropdown requires both; the dashboard will still show them. |
| :3000 shows 90 rows | Baseline cleared. Press **Reset demo** — it re-takes it. |
| Force Striim read fails | App is in HALT: `python striim/deploy.py start BambooHRToPostgres` |
| Workday stage fails with *"dimension values … do not exist"* | The 20 members aren't created yet. Expected. `npm run slots:check` |
| Workday stage fails with *"no pay figure"* | Set a pay rate in BambooHR. `PY Pay` is the only writable column, and 0 would overwrite a real value. |
| *"No available … demo slots"* | All 20 claimed. Add more to `ADAPTIVE_DEMO_SLOTS` (and have them created in Adaptive). |
| BambooHR card unreachable | Trial expired. A dead tenant answers **503** on the API while its portal still redirects. Update `BAMBOOHR_DOMAIN`/`BAMBOOHR_API_KEY`, then drop/deploy/start the Striim app. |
| Import fails with a seat limit | BambooHR account is full. Retrying never fixes it. |
| Everything dies | Low memory. `npm run syncdemo` alone is the lightest; the Instant Teams stack with its Temporal server is the heavy one. |

---

## Part 6 — Rehearse these two

**Force Striim read with a brand-new employee.** The restart is proven (Stop → Start → RUNNING in ~10s) and Automated mode bulk-reads on start, but this cluster's `MON` reports no event counters so I could never watch the read happen. If it hasn't landed 30s after the force read, wait out the five minutes.

**One reverse import.** Set `REVDEMO_BAMBOOHR_MODE=mock` first if you want a dry run — the mock exercises the same orchestration and mapping, only the final HTTP call differs. Then flip back to live. Remember every live rehearsal leaves a permanent record.

---

## Part 7 — Claims that hold up

Say these:

- "BambooHR, Striim and PostgreSQL are live systems on :3000."
- "Workday Adaptive and BambooHR are live on :3001, both over their real APIs."
- "`public.bamboohr_employees` is written by Striim; nothing in our code touches it."
- "The employee id is the correlation key across every system."
- "Re-processing the same person can't duplicate them — enforced by database constraints, not bookkeeping."

Don't say these:

- ~~"The employee is created in Workday."~~ A pre-allocated member is filled. The accurate line is *"real-time employee data synchronisation into pre-allocated Workday/Adaptive demo members."*
- ~~"Striim streams Workday to BambooHR."~~ It has no adapter for either end.
- ~~"This is real-time."~~ Striim's BambooHR reader is floored at 300s. The Postgres-to-Postgres CDC is genuinely sub-15s, but it isn't in either demo path right now.
