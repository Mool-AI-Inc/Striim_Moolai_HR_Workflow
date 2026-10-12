import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { approvalHostWorkflow } from "./fixtures/approvalHost.js";   // Plan-0 fixture — no module dependency
import { buildApprovalServer } from "../../src/platform/approval-api/approvalServer.js";
import type { PendingApproval } from "../../src/platform/domain/types.js";

const TASK_QUEUE = "approval-api-test";
let env: TestWorkflowEnvironment;
let worker: Worker;
let runPromise: Promise<void>;
let onRegistered: (() => void) | null = null;

const inbox = new Map<string, PendingApproval>();                    // in-memory stand-in for the DB inbox → offline
const activities = {                                                 // awaitApproval proxies ONLY these two
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
  return buildApprovalServer({
    listPending: async () => [...inbox.values()].filter((p) => p.status === "pending"),
    getApproval: async (id) => inbox.get(id),
    getHandle: (id) => env.client.workflow.getHandle(id),
  });
}
async function start(p: PendingApproval) {                          // approvalHostWorkflow registers the handler in its
  const registered = new Promise<void>((res) => { onRegistered = res; });  // first activation → await registerPending, then drive
  const handle = await env.client.workflow.start(approvalHostWorkflow, { taskQueue: TASK_QUEUE, workflowId: p.workflowId, args: [p, "7 days"] });
  await registered;
  return handle;
}

describe("approval API", () => {
  it("lists a pending item and a decision resolves the workflow (200)", async () => {
    const p = pendingOf("api-approve");
    const handle = await start(p);
    const app = server();
    const list = await app.inject({ method: "GET", url: "/approvals" });
    expect(list.json().some((r: PendingApproval) => r.id === p.id)).toBe(true);
    const ok = await app.inject({ method: "POST", url: `/approvals/${p.id}/decision`,
      payload: { approved: true, reason: "looks good", approver: "reviewer@instantteams.test" } });
    expect(ok.statusCode).toBe(200);
    expect(await handle.result()).toMatchObject({ approved: true });
  });

  it("a second decision on a completed workflow → 409", async () => {
    const p = pendingOf("api-double");
    const handle = await start(p);
    const app = server();
    await app.inject({ method: "POST", url: `/approvals/${p.id}/decision`, payload: { approved: true, reason: "first", approver: "a" } });
    await handle.result();
    const again = await app.inject({ method: "POST", url: `/approvals/${p.id}/decision`, payload: { approved: true, reason: "second", approver: "b" } });
    expect(again.statusCode).toBe(409);
  });

  it("an empty reason → 409 (validator rejects it)", async () => {
    const p = pendingOf("api-empty");
    await start(p);
    const app = server();
    const bad = await app.inject({ method: "POST", url: `/approvals/${p.id}/decision`, payload: { approved: true, reason: "", approver: "a" } });
    expect(bad.statusCode).toBe(409);
  });
});
