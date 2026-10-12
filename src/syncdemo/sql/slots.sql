-- Workday/Adaptive slot allocation.
--
-- Applied after schema.sql, with __SCHEMA__ substituted the same way.
--
-- WHY SLOTS EXIST AT ALL
--
-- Adaptive Planning's modeled-sheet dimensions are ENUMERATED. importConfigurableModelData can
-- only write a value against a dimension member that already exists, and the only API methods
-- available with these credentials are exportData, exportSheets and importConfigurableModelData —
-- none of which can create a member. Verified against the live tenant: a BambooHR id is rejected
-- with "dimension values for EmpID_EUPTD ... do not exist: 104".
--
-- So the destination member cannot be created by this pipeline. An administrator pre-allocates a
-- pool of empty members and the pipeline claims one per new hire. The employee's data is real and
-- flows end to end; only the empty destination is pre-made.
--
-- WHY THE SLOT LIST IS NOT IN HERE
--
-- The pool is configuration (ADAPTIVE_DEMO_SLOTS), not data. Seeding slot rows at migrate time
-- would mean two places could disagree about which members exist, and the authority is the
-- Adaptive model itself. So this table records only CLAIMS; a slot is AVAILABLE precisely when no
-- claim references it.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The persistent BambooHR employee -> Adaptive member mapping.
--
-- bamboo_employee_id is the PRIMARY KEY, which is what makes slot allocation idempotent: the
-- same employee arriving twice cannot take a second slot, because the second insert conflicts.
-- workday_slot_id is UNIQUE, which is what stops two different employees being handed the same
-- member under concurrency — the database refuses rather than the application remembering to.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS __SCHEMA__.employee_workday_mapping (
  bamboo_employee_id text PRIMARY KEY,
  workday_slot_id    text NOT NULL UNIQUE,
  employee_name      text,
  -- CLAIMED  : slot reserved, nothing written to Adaptive yet
  -- SYNCING  : the import is in flight
  -- SYNCED   : Adaptive accepted the row
  -- FAILED   : Adaptive rejected it. The slot stays claimed by this employee so a retry reuses
  --            the same member — releasing it would hand their member to the next arrival and
  --            make the failure unrecoverable in place.
  status             text NOT NULL DEFAULT 'CLAIMED'
                     CHECK (status IN ('CLAIMED', 'SYNCING', 'SYNCED', 'FAILED')),
  detail             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS __SCHEMA___mapping_status_idx
  ON __SCHEMA__.employee_workday_mapping (status);
