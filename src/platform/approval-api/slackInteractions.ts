/** @lifespan PRODUCTION — Slack Block Kit Approve/Reject → the same workflow Update. */
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkflowHandle } from "@temporalio/client";
import { decideUpdate } from "../approvals.js";
import type { PendingApproval } from "../domain/types.js";

export interface SlackDeps {
  getApproval(id: string): Promise<PendingApproval | undefined>;
  getHandle(workflowId: string): WorkflowHandle;
  signingSecret: string;
}

export function buildSlackInteractions(deps: SlackDeps): FastifyInstance {
  const app = Fastify();
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) => done(null, body));
  app.post("/webhooks/slack/interactions", async (req, reply) => {
    const ts = req.headers["x-slack-request-timestamp"] as string;
    const sig = req.headers["x-slack-signature"] as string;
    // Replay protection: reject stale/missing/garbage timestamps (Slack's ±5 min window) BEFORE the HMAC — the
    // v0:ts:body scheme exists precisely so a captured, validly-signed request can't be replayed later.
    const tsNum = Number(ts);
    if (!ts || !Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return reply.code(401).send();
    const base = `v0:${ts}:${req.body as string}`;
    const mine = Buffer.from("v0=" + createHmac("sha256", deps.signingSecret).update(base).digest("hex"));
    const theirs = Buffer.from(sig ?? "");
    // timingSafeEqual THROWS on unequal lengths — guard first so a short/absent sig is a clean 401, not a 500.
    if (!sig || mine.length !== theirs.length || !timingSafeEqual(mine, theirs)) return reply.code(401).send();
    const payload = JSON.parse(new URLSearchParams(req.body as string).get("payload")!);
    const action = payload.actions[0];                       // { action_id: "approve"|"reject", value: approvalId }
    const p = await deps.getApproval(action.value);
    if (!p) return reply.code(404).send();
    await deps.getHandle(p.workflowId).executeUpdate(decideUpdate, {
      args: [{ approved: action.action_id === "approve", reason: "via Slack", approver: payload.user?.username ?? "slack" }],
    });
    return reply.code(200).send();
  });
  return app;
}
