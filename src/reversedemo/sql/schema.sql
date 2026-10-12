-- Reverse pipeline: Workday/Adaptive -> Striim -> PostgreSQL -> BambooHR.
--
-- Its own schema, and its own process on its own port. The point of this pipeline is to be the
-- fallback for the forward one, so sharing state with it would defeat the exercise: a mistake in
-- one must not be able to take out the other.
--
-- WHY THIS DIRECTION IS EASIER THAN THE FORWARD ONE
--
-- The forward pipeline is blocked at the far end because Adaptive's dimensions are enumerated and
-- its API cannot create a member. Reversed, that constraint disappears:
--   reading Workday   exportData works — 530 rows, 523 distinct people, verified live
--   writing BambooHR  the REST API genuinely creates employees, and this repo's BambooHRClient
--                     already handles it, including the retry-after-ambiguous-create case
--
-- WHAT IS HARDER
--   * Adaptive carries NO EMAIL. BambooHR requires a unique work email, so it is synthesised and
--     used as the idempotency key.
--   * A BambooHR create is PERMANENT — the API has no delete, only termination — and consumes a
--     seat. So nothing here imports automatically; an operator picks each person. 523 people
--     arriving unattended would be 523 permanent records and an exhausted trial.

CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- What was read out of Workday. The source landing table — Workday's shape, not ours.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.workday_landing (
  member_id    text PRIMARY KEY,          -- EmpID_EUPTD, e.g. EMP_0337
  worker_name  text,
  gender       text,
  location     text,
  job_group    text,
  job_class    text,
  level_code   text,
  pay_rate     numeric,
  landed_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The intermediate database — our contract, mapped from the landing shape.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.employees (
  member_id     text PRIMARY KEY,
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  email         text NOT NULL,
  job_title     text,
  department    text,
  location      text,
  pay_rate      numeric,
  source_system text        NOT NULL DEFAULT 'workday-adaptive',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  sync_status   text        NOT NULL DEFAULT 'pending'
);

-- The synthesised email is the natural key, because BambooHR rejects duplicates on it. Unique
-- here too, so a collision is caught locally rather than as a 409 from the HRIS.
CREATE UNIQUE INDEX IF NOT EXISTS __SCHEMA___employees_email_key
  ON __SCHEMA__.employees (lower(email));

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Workday member -> the BambooHR employee it became.
--
-- member_id is the PRIMARY KEY, which is what makes the import idempotent: the same Workday
-- person cannot be created twice however many times the event is replayed. This is the mirror of
-- employee_workday_mapping in the forward pipeline, and it matters more here — a duplicate means
-- a permanent extra human record in a real HRIS and a wasted seat.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.bamboohr_mapping (
  member_id          text PRIMARY KEY,
  bamboo_employee_id text UNIQUE,
  email              text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'CREATING', 'CREATED', 'FAILED')),
  detail             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __SCHEMA__.stage_state (
  member_id  text        NOT NULL,
  stage      text        NOT NULL,   -- workday | striim | postgres | bamboohr
  status     text        NOT NULL,   -- pending | processing | synced | failed
  detail     text,
  attempts   int         NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, stage)
);

CREATE TABLE IF NOT EXISTS __SCHEMA__.events (
  id        bigserial   PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  member_id text,
  stage     text,
  level     text        NOT NULL DEFAULT 'info',
  message   text        NOT NULL
);

CREATE TABLE IF NOT EXISTS __SCHEMA__.processed_steps (
  step_key     text PRIMARY KEY,
  member_id    text NOT NULL,
  stage        text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
