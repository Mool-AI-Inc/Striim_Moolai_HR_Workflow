import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { approvalHostWorkflow } from "./fixtures/approvalHost.js";   // Plan-0 fixture — no module dependency
import { buildSlackInteractions } from "../../src/platform/approval-api/slackInteractions.js";
import type { PendingApproval } from "../../src/platform/domain/types.js";

const TASK_QUEUE = "slack-interactions-test";
const SIGNING_SECRET = "test-signing-secret";
let env: TestWorkflowEnvironment;
let worker: Worker;
let runPromise: Promise<void>;
let onRegistered: (() => void) | null = null;

const inbox = new Map<string, PendingApproval>();                    // in-memory stand-in for the DB inbox → offline
const activities = {
  registerPending: async (p: PendingApproval) => { inbox.set(p.id, p); onRegistered?.(); },
  resolvePending: async (id: string, status: PendingApproval["status"]) => {
    const p = inbox.get(id); if (p) inbox.set(id, { ...p, status });
  },
};
const pendingOf = (id: string): PendingApproval => ({
  id, workflowId: `wf-${id}`, kind: "packet-assignment", title: `review ${id}`,
  detail: { packetId: "RFT-CX", rationale: "RFT in CX", confidence: 1, flags: [] },
  createdAt: new Date().toISOString(), status: "pending",
});

function slackBody(approvalId: string, actionId: "approve" | "reject"): string {
  const payload = JSON.stringify({ actions: [{ action_id: actionId, value: approvalId }], user: { username: "reviewer" } });
  return new URLSearchParams({ payload }).toString();
}
function sign(body: string, ts: string): Record<string, string> {
  const s = "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${body}`).digest("hex");
  return { "x-slack-signature": s, "x-slack-request-timestamp": ts, "content-type": "application/x-www-form-urlencoded" };
}

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./fixtures/approvalHost.ts", import.meta.url)),
    activities,
  });
  runPromise = worker.run();
});
afterAll(async () => { worker.shutdown(); await runPromise.catch(() => {}); await env.teardown(); });

function server() {
  return buildSlackInteractions({
    getApproval: async (id) => inbox.get(id),
    getHandle: (id) => env.client.workflow.getHandle(id),
    signingSecret: SIGNING_SECRET,
  });
}
async function start(p: PendingApproval) {
  const registered = new Promise<void>((res) => { onRegistered = res; });
  const handle = await env.client.workflow.start(approvalHostWorkflow, { taskQueue: TASK_QUEUE, workflowId: p.workflowId, args: [p, "7 days"] });
  await registered;
  return handle;
}

describe("Slack interactions endpoint", () => {
  it("a signed approve action drives the workflow Update (200 + resolves)", async () => {
    const p = pendingOf("slack-approve");
    const handle = await start(p);
    const app = server();
    const body = slackBody(p.id, "approve");
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await app.inject({ method: "POST", url: "/webhooks/slack/interactions", headers: sign(body, ts), payload: body });
    expect(r.statusCode).toBe(200);
    expect(await handle.result()).toMatchObject({ approved: true });
  });

  it("a bad signature → 401 (no update sent)", async () => {
    const p = pendingOf("slack-badsig");
    await start(p);
    const app = server();
    const body = slackBody(p.id, "approve");
    const r = await app.inject({ method: "POST", url: "/webhooks/slack/interactions",
      headers: { "x-slack-signature": "v0=deadbeef", "x-slack-request-timestamp": "123", "content-type": "application/x-www-form-urlencoded" },
      payload: body });
    expect(r.statusCode).toBe(401);
  });
});
