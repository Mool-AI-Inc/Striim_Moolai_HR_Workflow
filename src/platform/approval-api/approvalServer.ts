/**
 * Approval API — list/detail from the DB inbox; a decision drives the workflow Update (HITL).
 * @lifespan PRODUCTION — the reviewer surface + Slack fallback both post decisions here.
 * @responsibility GET the pending inbox, GET one item, POST a decision → executeUpdate(decideUpdate); deps injected.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { WorkflowHandle } from "@temporalio/client";
import { decideUpdate } from "../approvals.js";
import type { PendingApproval, ApprovalDecision } from "../domain/types.js";

export interface ApprovalServerDeps {
  listPending(): Promise<PendingApproval[]>;
  getApproval(id: string): Promise<PendingApproval | undefined>;
  getHandle(workflowId: string): WorkflowHandle;   // prod: (id) => (await getClient()).workflow.getHandle(id)
}

export function buildApprovalServer(deps: ApprovalServerDeps): FastifyInstance {
  const app = Fastify();
  app.get("/approvals", async () => deps.listPending());
  app.get("/approvals/:id", async (req, reply) => {
    const p = await deps.getApproval((req.params as { id: string }).id);
    return p ? p : reply.code(404).send({ error: "not found" });
  });
  // ponytail: MVP has NO reviewer auth — this trusts `approver` from the body and does no per-kind authz (spec §H
  // defers real SSO; the app sends a stub `approver`). At cutover: a Fastify preHandler authenticates the reviewer,
  // `approver` is derived from the authenticated principal (not the body), and authz checks they may decide this kind.
  // The reason-required + no-double-decide trust-boundary checks already run server-side in the decideUpdate validator,
  // and the try/catch below contains a malformed/null body as a 409 rather than a crash — so casting is safe here.
  app.post("/approvals/:id/decision", async (req, reply) => {
    const p = await deps.getApproval((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "not found" });
    const decision = req.body as ApprovalDecision;
    // Reason is required — enforce at the boundary (also hardens the req.body cast). startUpdate(ACCEPTED) returns
    // before a validator rejection surfaces, so we can't lean on the workflow validator for this one.
    if (typeof decision?.reason !== "string" || !decision.reason.trim()) return reply.code(409).send({ error: "reason required" });
    try {
      // Wait only for ACCEPTED (validator passed + decision recorded), not COMPLETED — the COMPLETED long-poll
      // deadlocks the time-skipping clock in the interactive demo. "already decided" still 409s via the closed workflow.
      await deps.getHandle(p.workflowId).startUpdate(decideUpdate, { args: [decision], waitForStage: "ACCEPTED" });
      return reply.code(200).send({ status: "recorded" });
    } catch {
      return reply.code(409).send({ error: "decision rejected" });   // validator: empty reason / already decided
    }
  });
  return app;
}
