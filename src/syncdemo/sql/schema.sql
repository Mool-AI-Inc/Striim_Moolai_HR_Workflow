-- Schema for the BambooHR -> Striim -> PostgreSQL -> Workday demo.
--
-- Everything lives in its own `syncdemo` schema. That is not tidiness for its own sake: the
-- platform in this repo already owns a `public.employees` table with 313 rows that a live
-- Striim CDC pipeline replicates to a second database. Creating a second `employees` in
-- `public` would either collide with it or, worse, quietly join it and start feeding rows into
-- a replicated table. The demo owns `syncdemo` and touches nothing else.

CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The intermediate database: what Striim writes and the website reads.
-- Column list is the one specified for this demo.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.employees (
  employee_id    text PRIMARY KEY,
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  email          text NOT NULL,
  job_title      text,
  department     text,
  location       text,
  phone          text,
  hire_date      date,
  -- The figure written to Adaptive's "PY Pay" column, the only writable column on the EUPTD
  -- import template. Nullable: an employee with no pay figure cannot be synced, and the
  -- Workday stage refuses rather than writing a zero over a real number.
  pay_rate       numeric,
  source_system  text        NOT NULL DEFAULT 'bamboohr',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  sync_status    text        NOT NULL DEFAULT 'pending'
);

-- Email is a natural key in BambooHR (it rejects duplicates), so it is one here too. This is
-- the second line of idempotency defence: employee_id catches a replayed event, this catches
-- the same human arriving under a new id.
CREATE UNIQUE INDEX IF NOT EXISTS __SCHEMA___employees_email_key
  ON __SCHEMA__.employees (lower(email));

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- BambooHR's OWN database, when BambooHR is mocked.
--
-- Deliberately a separate table from __SCHEMA__.employees rather than a flag on it. The whole
-- claim of this demo is that a record travels BETWEEN systems; if the source and the target are
-- the same row, nothing travels and the pipeline is theatre. Striim reads this table exactly as
-- it would read BambooHR's REST API, and writes __SCHEMA__.employees. In live mode this table is
-- unused and the real BambooHR account plays the part.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.mock_bamboohr_employees (
  employee_id text PRIMARY KEY,
  first_name  text NOT NULL,
  last_name   text NOT NULL,
  email       text NOT NULL,
  job_title   text,
  department  text,
  location    text,
  phone       text,
  hire_date   date,
  pay_rate    numeric,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Bumped on every write. This is what makes the Striim mock a real change-detector: it polls
  -- for rows whose revision is above its watermark, which is what a CDC reader does. Nothing
  -- in the UI is driven by a timer pretending to be a pipeline.
  revision    bigint      NOT NULL DEFAULT 1
);

CREATE SEQUENCE IF NOT EXISTS __SCHEMA__.mock_bamboohr_revision_seq;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Striim's landing table.
--
-- In LIVE mode this is public.bamboohr_employees, created by the real BambooHR Reader with
-- MigrateSchema. In MOCK mode the Striim mock writes here. Either way the pipeline's
-- postgres stage reads a landing row and maps it into __SCHEMA__.employees, so the two-hop
-- shape (Striim owns the landing shape, a mapping owns the application contract) is the same
-- in both modes.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.landing (
  employee_id text PRIMARY KEY,
  payload     jsonb       NOT NULL,
  landed_at   timestamptz NOT NULL DEFAULT now(),
  revision    bigint      NOT NULL DEFAULT 1
);

-- Where the Striim mock has read up to. One row.
CREATE TABLE IF NOT EXISTS __SCHEMA__.striim_watermark (
  id        int    PRIMARY KEY DEFAULT 1,
  revision  bigint NOT NULL DEFAULT 0,
  CONSTRAINT __SCHEMA___watermark_single_row CHECK (id = 1)
);
INSERT INTO __SCHEMA__.striim_watermark (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Workday's OWN store, when Workday is mocked. Same reasoning as the BambooHR mock table.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.mock_workday_workers (
  worker_id     text PRIMARY KEY,   -- Workday's own id, NOT the BambooHR employee_id
  employee_id   text NOT NULL UNIQUE,
  legal_name    text NOT NULL,
  email         text NOT NULL,
  position      text,
  cost_center   text,
  location      text,
  hire_date     date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Per-stage status. The UI renders THIS; it does not keep its own idea of where a record is.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.stage_state (
  employee_id text        NOT NULL,
  stage       text        NOT NULL,   -- bamboohr | striim | postgres | workday
  status      text        NOT NULL,   -- pending | processing | synced | failed
  detail      text,
  attempts    int         NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, stage)
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The activity log. Persisted rather than in-memory so a reconnecting browser, or one opened
-- after the fact, sees the same history the first one did.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.events (
  id          bigserial   PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  employee_id text,
  stage       text,
  level       text        NOT NULL DEFAULT 'info',   -- info | success | warn | error
  message     text        NOT NULL
);
CREATE INDEX IF NOT EXISTS __SCHEMA___events_at_idx ON __SCHEMA__.events (id DESC);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Idempotency ledger.
--
-- Every pipeline step is keyed by a deterministic id (employee_id + stage + revision). A step
-- that has already been recorded here is skipped, so re-delivering an event — which a real CDC
-- pipeline does routinely, and which the retry button does deliberately — cannot produce a
-- second employee or a second Workday worker.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.processed_steps (
  step_key     text PRIMARY KEY,
  employee_id  text NOT NULL,
  stage        text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- What this pipeline has pushed to LIVE Workday.
--
-- Adaptive Planning has no cheap "how many rows are on this sheet" call, and an exportData
-- round trip per dashboard refresh would be slow and wasteful. Counting in memory was worse:
-- the number reset to zero on every restart, so the dashboard's Workday card disagreed with
-- reality the moment the process was recycled. This is the durable answer to the only question
-- the pipeline can actually answer — who WE have synchronised — and the card is labelled as
-- such rather than claiming to know the sheet's true size.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.workday_synced (
  employee_id text PRIMARY KEY,
  worker_ref  text NOT NULL,
  detail      text,
  synced_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Employees that already existed when live mode first started.
--
-- In live mode the integration layer reads the REAL Striim landing table, which holds every
-- employee in the tenant — 90 of them. Without this, the first poll treats all 90 as new
-- arrivals, maps them into the intermediate table and sends each one downstream to Workday.
-- That is 90 writes into a planning model nobody asked for, and a dashboard showing 90 rows
-- when the demo is about adding ONE person.
--
-- So on first live start the current landing ids are recorded here and skipped. Only employees
-- who arrive AFTER that flow through, which is exactly the onboarding journey being shown.
-- Clearing this table (the dashboard's reset does) re-arms the backfill deliberately.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.bootstrap_skip (
  employee_id text PRIMARY KEY,
  noted_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Column additions, for databases that already have the tables above.
--
-- CREATE TABLE IF NOT EXISTS does not evolve an existing table — it is a no-op, silently. So a
-- column added to a definition above never appears on a database that was created before it, and
-- the failure surfaces far away as `column "pay_rate" of relation "mock_bamboohr_employees" does
-- not exist`. This file runs on every boot, so ALTER .. ADD COLUMN IF NOT EXISTS is the honest
-- place for an additive change.
-- ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE __SCHEMA__.employees               ADD COLUMN IF NOT EXISTS pay_rate numeric;
ALTER TABLE __SCHEMA__.mock_bamboohr_employees ADD COLUMN IF NOT EXISTS pay_rate numeric;
