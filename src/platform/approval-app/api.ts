/** @lifespan PRODUCTION — the approval SPA's client for the Fastify approval API. */
/// <reference types="vite/client" />
import type { PendingApproval, ApprovalDecision } from "../domain/types.js";

const BASE = import.meta.env.VITE_APPROVAL_API ?? "";

export async function listApprovals(): Promise<PendingApproval[]> {
  const r = await fetch(`${BASE}/approvals`);
  return r.json();
}

export async function postDecision(id: string, d: Pick<ApprovalDecision, "approved" | "reason" | "selectedDocs">): Promise<void> {
  const r = await fetch(`${BASE}/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...d, approver: "reviewer" }),   // MVP: approver from session stub
  });
  if (!r.ok) throw new Error(String(r.status));
}

// ── Journey dashboard (demo /journey aggregate: automated receipts + live approvals) ──
export interface JourneyStep {
  key: string;
  label: string;
  kind: "auto" | "approval";
  status: "done" | "pending" | "approved" | "rejected" | "expired" | "scheduled" | "waiting";
  note?: string;
  summary?: string;
  approval?: PendingApproval;
}
export interface Journey {
  employee: { id: string; name: string } | null;
  clock: { day: number };
  steps: JourneyStep[];
}

export async function getJourney(): Promise<Journey> {
  const r = await fetch(`${BASE}/journey`);
  return r.json();
}

export interface EmployeeOption { id: string; name: string; employeeType: string; costCenter: string; }

export async function getEmployees(): Promise<EmployeeOption[]> {
  const r = await fetch(`${BASE}/employees`);
  return r.json();
}

export async function runEmployee(id: string): Promise<Journey> {
  const r = await fetch(`${BASE}/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeId: id }),
  });
  return r.json();
}

export async function advanceClock(days: number): Promise<Journey> {
  const r = await fetch(`${BASE}/clock/advance`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days }),
  });
  return r.json();
}

// ── Recurring automations (UC5 birthday/anniversary, UC8 starts-tomorrow, UC4 monthly finance) ──
export interface ScanResult {
  scanToday: string;
  scanMonth: string;
  birthdays: string[];
  anniversaries: string[];
  slackInvites: string[];
  financeReport: { location?: string; rowCount?: number; transitionCount?: number; approvalId?: string } | null;
}

export async function runScans(): Promise<ScanResult> {
  const r = await fetch(`${BASE}/scans/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// ── Migration panel (Striim CDC: source database -> target database) ──
export interface TableState { table: string; rows: number; checksum: string; }
export interface TableComparison { table: string; source: TableState; target: TableState; match: boolean; }
export interface SlotState {
  name: string; exists: boolean; active: boolean; plugin: string | null;
  restartLsn: string | null; confirmedFlushLsn: string | null; currentWalLsn: string | null;
}
export interface CutoverStep { name: string; ok: boolean; detail?: string; }

export type MigrationStatus =
  | { configured: false; reason: string }
  | {
      configured: true;
      sourceUrlLabel: string; targetUrlLabel: string;
      writingTo: "source" | "target";
      acceptingStarts: boolean;
      cdcState: string; loadState: string;
      slot: SlotState; slotReady: boolean;
      tables: TableComparison[];
      lastCutover: CutoverStep[] | null;
      lastError: string | null;
    };

export interface MigrationActionResult {
  ok: boolean;
  reason?: string;
  refusedAt?: string | null;
  steps?: CutoverStep[];
  tables?: TableComparison[];
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
  const r = await fetch(`${BASE}/migration/status`);
  return r.json();
}

/** Every migration action is a POST behind a button; a refusal comes back as ok:false. */
async function migrationPost(path: string): Promise<MigrationActionResult> {
  const r = await fetch(`${BASE}/migration/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  return r.json() as Promise<MigrationActionResult>;
}

export const startCdc = (): Promise<MigrationActionResult> => migrationPost("cdc/start");
export const startInitialLoad = (): Promise<MigrationActionResult> => migrationPost("initial-load");
export const runCutover = (): Promise<MigrationActionResult> => migrationPost("cutover");
export const runReconcile = (): Promise<MigrationActionResult> => migrationPost("reconcile");
export const resetMigration = (): Promise<MigrationActionResult> => migrationPost("reset");

// ── Which HRIS is actually feeding the platform ──
export interface HrisDestination {
  id: string;                 // workday-adaptive | none
  label: string;              // Workday Adaptive Planning
  detail: string;             // instance code
  ready: boolean;             // credentials usable — NOT "a write has happened"
  mode: string;
}

export interface HrisStatus {
  id: string;                 // bamboohr | simulator
  label: string;              // BambooHR
  detail: string;             // the subdomain, or why not
  connected: boolean;
  employees: number;
  landingRows: number;
  lastSyncedAt: string | null;
  reason?: string;
  destination: HrisDestination;
}

export async function getHrisStatus(): Promise<HrisStatus> {
  const r = await fetch(`${BASE}/hris/status`);
  return r.json();
}
