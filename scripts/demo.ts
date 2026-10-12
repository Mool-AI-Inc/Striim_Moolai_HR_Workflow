/** @lifespan THROWAWAY — the five-UC New-Hire-Arc demo (data + clock, durability, HITL). */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { buildSimulator } from "../simulator/saasSimulator.js";
import { loadDemoEmployees, makeEmployee } from "../src/synthdata/scenarios.js";
import { loadEnv } from "../src/platform/config/env.js";
import { MODULES } from "../src/platform/registry.js";
import { mergeActivities, workflowsBundlePath } from "../src/platform/worker.js";
import { buildIngress } from "../src/platform/ingress.js";
import { buildConnectorRegistry } from "../src/platform/connectors/registry.js";
import { buildApprovalServer } from "../src/platform/approval-api/approvalServer.js";
import { listPending, getApproval } from "../src/platform/db/approvals.js";
import { decideUpdate, pendingQuery } from "../src/platform/approvals.js";
import { migrate } from "../src/platform/db/sendLedger.js";

const today = new Date().toISOString().slice(0, 10);

async function main() {
  await migrate();                                          // bootstrap the ledger schema (compose app-postgres must be up)

  // 1. Simulator seeded with Dana (consenting, hired TODAY → her Day-60 timer is in the future).
  //    The worker's activities capture loadEnv() at IMPORT time (const env = loadEnv() at module top), so the sim
  //    MUST bind to the port those connectors already captured — not a random one, and mutating process.env here
  //    would be too late. Bind to loadEnv().simulatorUrl's port (default :8085, honors a SIMULATOR_URL override).
  const simPort = Number(new URL(loadEnv().simulatorUrl).port || 8085);
  const dana = makeEmployee({ employeeId: "EMP-DANA", firstName: "Dana", email: "dana@instantteams.test", smsConsent: true, hireDate: today });
  const sim = buildSimulator([...loadDemoEmployees(), dana]);
  await sim.listen({ port: simPort, host: "127.0.0.1" });

  // 2. Temporal time-skipping env + worker over the REAL registry.
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const host = { temporal: env.client, connectors: buildConnectorRegistry() } as const;
  let worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "main", workflowsPath: workflowsBundlePath(), activities: mergeActivities(MODULES) });
  let run = worker.run();

  // 3. Approval surface for the React app.
  const approvalApi = buildApprovalServer({ listPending, getApproval, getHandle: (id) => env.client.workflow.getHandle(id) });
  await approvalApi.listen({ port: 0 });

  // 4. Fire the new-hire event → fans out to newHireLifecycle (UC1 welcome + UC7 SMS + UC2a Day-60) AND packetSelection (UC6).
  const ingress = buildIngress(MODULES, host, { verifyPaylocityAuth: () => true });
  await ingress.inject({ method: "POST", url: "/webhooks/paylocity", payload: { companyId: "C1", employeeId: "EMP-DANA" } });

  // 5. Auto-approve UC6 (packet) then UC2b (benefits child) once each has registered its pending approval.
  await autoApprove(env, "packet:EMP-DANA");
  // ... newHireLifecycle's Day-60 timer matures instantly under time-skipping → compliance email + starts benefits60:EMP-DANA
  await autoApprove(env, "benefits60:EMP-DANA");

  // 6. Durability beat — kill + restart the worker; the time-skipping server holds all workflow + inbox state.
  worker.shutdown(); await run.catch(() => {});
  worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "main", workflowsPath: workflowsBundlePath(), activities: mergeActivities(MODULES) });
  run = worker.run();

  // 7. Print every inbox as the receipts (they survived the restart).
  for (const box of ["/_sent", "/_sms", "/_assignments", "/_ensends"]) {
    const r = await sim.inject({ method: "GET", url: box }); console.log(box, r.json());
  }
  console.log("pending:", await listPending());
  console.log("approval app → point VITE_APPROVAL_API at", `http://127.0.0.1:${(approvalApi.server.address() as { port: number }).port}`);

  worker.shutdown(); await run.catch(() => {}); await env.teardown(); await sim.close(); await approvalApi.close();
}

async function autoApprove(env: TestWorkflowEnvironment, workflowId: string) {
  const handle = env.client.workflow.getHandle(workflowId);
  // packetSelection runs recommendPacket BEFORE awaitApproval, so the `decide` handler isn't registered yet — gate on
  // pendingQuery (set in the SAME activation as decideUpdate) before sending, or the update races (Plan-2 discovery).
  for (let i = 0; i < 100; i++) {
    if (await handle.query(pendingQuery).catch(() => null)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "demo auto-approve", approver: "demo" }] });
}

main().catch((e) => { console.error(e); process.exit(1); });
