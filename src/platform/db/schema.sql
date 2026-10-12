-- Ledger + opt-out + approvals inbox. Idempotent (CREATE TABLE IF NOT EXISTS); reset is `docker compose down -v`.
-- No migration scripts (pre-prod preserves no data); this file evolves freely.

CREATE TABLE IF NOT EXISTS send_ledger (
  id             bigserial PRIMARY KEY,
  idempotency_key text UNIQUE NOT NULL,
  "to"           text,
  template       text,
  status         text,                       -- sent | failed | alarm
  message_id     text,
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_opt_out (
  phone      text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id          text PRIMARY KEY,
  workflow_id text NOT NULL,
  kind        text,
  title       text,
  detail      jsonb,
  status      text NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  created_at  timestamptz DEFAULT now(),
  resolved_at timestamptz
);

-- Employee master data. Added for the Striim migration demo: the bulk historical load.
-- Mirrors EmployeeRecord in src/platform/domain/types.ts. Seeded from fixtures/employees.json
-- by scripts/load-employees.ts; the fixture stays the source of truth for offline tests.
CREATE TABLE IF NOT EXISTS employees (
  employee_id       text PRIMARY KEY,
  first_name        text NOT NULL,
  last_name         text NOT NULL,
  email             text NOT NULL,
  birth_date        date,
  hire_date         date,
  employee_type     text,
  status            text,
  cost_center       text,
  prior_cost_center text,
  phone             text,
  sms_consent       boolean NOT NULL DEFAULT false,
  updated_at        timestamptz DEFAULT now()
);

-- REPLICA IDENTITY FULL is not optional, and getting it wrong fails silently.
--
-- Striim's PostgreSQLReader tails wal2json. With the default replica identity, an UPDATE
-- reaches the write-ahead log without enough of the old row for the writer to build an
-- UPDATE statement against the target. Measured on this cluster: INSERTs replicated in
-- under 10 seconds, UPDATEs never arrived at all, and nothing anywhere reported an error
-- — the pipeline stayed RUNNING with zero rejected rows. An approval flipping
-- pending -> approved is an UPDATE, so without this the migration silently loses exactly
-- the state the demo is about.
--
-- FULL rather than the primary key: it costs more WAL, but every one of these tables is
-- small and "the key is enough" is an assumption that is expensive to be wrong about.
ALTER TABLE employees         REPLICA IDENTITY FULL;
ALTER TABLE send_ledger       REPLICA IDENTITY FULL;
ALTER TABLE sms_opt_out       REPLICA IDENTITY FULL;
ALTER TABLE pending_approvals REPLICA IDENTITY FULL;

-- HRIS write-back state. Leg 2 of the HRIS pipeline pushes employees into BambooHR, and
-- these two tables are what make that safe to retry.
--
-- Why a row per (employee, target) rather than per employee: a migrated employee is not one
-- API call. The core record is POST /employees/, but role, pay and employment status are
-- separate row-based tables. A failure between them leaves a real person present in the
-- customer's HRIS with no compensation attached, and a naive retry creates a SECOND person.
CREATE TABLE IF NOT EXISTS hris_id_map (
  source_employee_id text NOT NULL,
  system             text NOT NULL,          -- 'bamboohr'
  remote_id          text NOT NULL,          -- the id BambooHR returned in its Location header
  created_at         timestamptz DEFAULT now(),
  PRIMARY KEY (source_employee_id, system)
);

CREATE TABLE IF NOT EXISTS hris_load_ledger (
  source_employee_id text NOT NULL,
  system             text NOT NULL,
  target             text NOT NULL,          -- 'employee' | 'jobInfo' | 'compensation' | ...
  state              text NOT NULL,          -- pending | sent | failed | needs_human
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  updated_at         timestamptz DEFAULT now(),
  PRIMARY KEY (source_employee_id, system, target)
);

-- Landing table for Striim's BambooHR Reader: DELIBERATELY NOT DECLARED HERE.
--
-- With MigrateSchema:true the reader creates public.bamboohr_employees itself, from the
-- schema BambooHR actually returns. Pre-declaring even a one-column stub makes the reader
-- HALT on the first event with TargetTableSchemaMismatchException — it compares its incoming
-- CREATE event against what exists and refuses to write into a shape it did not make.
--
-- So the reader owns that table's shape and this file does not mention it. The mapping in
-- striim/map_bamboohr_to_employees.sql is where we adapt whatever lands into the employees
-- table the application reads.

-- Compensation carried across from the HRIS, split into figure and currency.
--
-- BambooHR returns payRate as a SINGLE STRING with the currency inside it — "65000.00 USD",
-- "50000.00 GBP", "72000.00 AUD". Storing that verbatim makes it unusable for arithmetic, and
-- writing it into a pay column in a planning model would be worse than useless. So it is
-- split on the way in, and the currency is kept rather than assumed: this account genuinely
-- holds USD, GBP and AUD employees, and averaging across them without conversion is the
-- classic way to produce a confidently wrong pay-equity number.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pay_rate     numeric;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pay_currency text;

-- Columns carried so the HRIS and the planning model show the SAME employee record.
--
-- The Adaptive demographics sheet's import template has fixed columns — Gender, Location,
-- Job_Group, Job_Classification, Worker_Name, EmpID_EUPTD and a pay metric. These are the
-- BambooHR fields that map onto them one-for-one, so a reviewer can put the two systems side
-- by side and see the same person rather than two partial views of them.
--
-- gender is here because the target sheet is a PAY-EQUITY model and that is the axis it
-- analyses. It is read from BambooHR, never inferred — a guessed value in an equity model is
-- worse than a blank one.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender    text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location  text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_title text;
