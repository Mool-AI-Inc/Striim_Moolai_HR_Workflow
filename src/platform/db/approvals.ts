/**
 * Approvals inbox (DB side) — the pending_approvals table read by the approval app, written by the workflow.
 * @lifespan PRODUCTION — the HITL audit trail + the inbox the reviewer UI reads (not a Query fan-out).
 * @responsibility Parameterized CRUD: upsertPending, setStatus, getApproval, listPending.
 */
import { getPool } from "./pool.js";
import type { PendingApproval } from "../domain/types.js";

interface Row { id: string; workflow_id: string; kind: string; title: string; detail: unknown; status: string; created_at: string | Date; }
const toApproval = (r: Row): PendingApproval => ({
  id: r.id, workflowId: r.workflow_id, kind: r.kind as PendingApproval["kind"], title: r.title,
  detail: r.detail, createdAt: new Date(r.created_at).toISOString(), status: r.status as PendingApproval["status"],
});

export async function upsertPending(p: PendingApproval): Promise<void> {
  await getPool().query(
    `INSERT INTO pending_approvals (id, workflow_id, kind, title, detail, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
    [p.id, p.workflowId, p.kind, p.title, JSON.stringify(p.detail), p.status],
  );
}

export async function setStatus(id: string, status: PendingApproval["status"]): Promise<void> {
  await getPool().query(`UPDATE pending_approvals SET status = $2, resolved_at = now() WHERE id = $1`, [id, status]);
}

export async function getApproval(id: string): Promise<PendingApproval | undefined> {
  const r = await getPool().query<Row>(`SELECT id, workflow_id, kind, title, detail, status, created_at FROM pending_approvals WHERE id = $1`, [id]);
  return r.rows[0] ? toApproval(r.rows[0]) : undefined;
}

export async function listPending(): Promise<PendingApproval[]> {
  const r = await getPool().query<Row>(`SELECT id, workflow_id, kind, title, detail, status, created_at FROM pending_approvals WHERE status = 'pending' ORDER BY created_at`);
  return r.rows.map(toApproval);
}
