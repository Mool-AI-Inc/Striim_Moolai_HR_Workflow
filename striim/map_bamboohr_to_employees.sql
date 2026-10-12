-- BambooHR landing -> the employees table the platform reads.
--
-- This is the step that makes leg 1 load-bearing. Without it Striim lands 90 rows into
-- bamboohr_employees that nothing reads, and the platform's employees table is populated
-- entirely by a direct REST call in scripts/enrich-bamboohr.ts — which would make the Striim
-- application decorative. Run this first, then enrich; see scripts/sync-bamboohr.ts, which
-- runs the pair in that order.
--
-- Column names below are the REAL ones the Striim BambooHR Reader created, read back from
-- information_schema after the first load. It lowercases everything and produces 20 columns,
-- with a PRIMARY KEY on id. Do not infer these from BambooHR's API docs; the reader's shape
-- is its own.
--
-- WHAT THIS FEED CAN AND CANNOT SUPPLY.
-- The reader's `Employees` table is BambooHR's DIRECTORY. It carries identity, contact,
-- department, and — often overlooked — gender, jobtitle and location, which are mapped below.
-- It does NOT carry hireDate, dateOfBirth, status, employmentHistoryStatus or payRate. Those
-- are fields on the employee record, not tables.
--
-- Adding 'jobInfo;employmentStatus;compensation' to the reader's Tables property does NOT
-- reach them: the connector accepts the names silently, stays RUNNING, and creates no landing
-- tables. Verified — bamboohr_jobinfo, bamboohr_employmentstatus and bamboohr_compensation do
-- not exist after a successful load. The custom-report endpoint is the only route, which is
-- what scripts/enrich-bamboohr.ts uses. An earlier version of this comment suggested those
-- tables were the fix; they are not.
--
-- So after THIS step alone: hire_date and birth_date are NULL, so UC2a/UC2b (the Day-60 arc)
-- cannot anchor and UC5 (birthdays) cannot match. Those become populated by the enrich step
-- that follows, which is why the two run as a pair and not in isolation.
--
-- Idempotent: safe to re-run after every incremental load.

INSERT INTO employees (
  employee_id, first_name, last_name, email,
  birth_date, hire_date, employee_type, status,
  cost_center, phone, sms_consent,
  gender, location, job_title, updated_at
)
SELECT
  b.id,
  COALESCE(NULLIF(b.firstname, ''), COALESCE(b.displayname, 'unknown')),
  COALESCE(NULLIF(b.lastname, ''), ''),
  COALESCE(NULLIF(b.workemail, ''), b.id || '@no-email.invalid'),
  NULL::date,                 -- not in the directory payload; the enrich step fills it
  NULL::date,                 -- not in the directory payload; the enrich step fills it
  -- No employment-status field arrives, so type cannot be derived here. 'RFT' is the majority
  -- case and is corrected by the enrich step from employmentHistoryStatus; it is flagged as
  -- an assumption rather than a reading.
  'RFT',
  -- 'A' is defensible for THIS feed specifically, not a blanket guess: the BambooHR directory
  -- omits inactive and terminated people (90 rows here against 109 in the custom report), so
  -- everyone who appears in bamboohr_employees is someone BambooHR is willing to list
  -- publicly. The enrich step still overwrites this from the authoritative status field.
  'A',
  -- BambooHR's `department` is the closest thing to a cost centre. Free text, so it will not
  -- match the CC-* vocabulary UC6 keys off — mapped through, not invented.
  COALESCE(NULLIF(b.department, ''), 'CC-OPS'),
  COALESCE(NULLIF(b.mobilephone, ''), COALESCE(b.workphone, '')),
  -- NEVER infer SMS consent from an HRIS. A phone number is not permission to text it, and
  -- UC7 gates on this. False always; consent is captured separately and owned by us.
  false,
  -- These three DO arrive in the directory and were previously dropped on the floor, which
  -- left the enrich step as the only source for them. Mapping them here means the Striim feed
  -- alone produces a usable employee record.
  NULLIF(b.gender, ''),
  NULLIF(b.location, ''),
  NULLIF(b.jobtitle, ''),
  now()
FROM bamboohr_employees b
WHERE b.id IS NOT NULL AND b.id <> ''
ON CONFLICT (employee_id) DO UPDATE SET
  first_name  = EXCLUDED.first_name,
  last_name   = EXCLUDED.last_name,
  email       = EXCLUDED.email,
  cost_center = EXCLUDED.cost_center,
  phone       = EXCLUDED.phone,
  -- COALESCE, not a bare assignment: a field blank in the directory must not erase a value
  -- the enrich step already wrote from the custom report.
  gender      = COALESCE(EXCLUDED.gender,    employees.gender),
  location    = COALESCE(EXCLUDED.location,  employees.location),
  job_title   = COALESCE(EXCLUDED.job_title, employees.job_title),
  -- sms_consent, status, employee_type and the date columns are deliberately NOT overwritten:
  -- consent is ours, and the other four are owned by the enrich step, which reads them from a
  -- better source than the directory. Overwriting them here would undo that on every run.
  updated_at  = now();
