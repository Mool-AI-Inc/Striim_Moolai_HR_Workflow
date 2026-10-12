import { describe, it, expect } from "vitest";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { buildIngress } from "../../src/platform/ingress.js";
import type { HostCtx, UseCaseModule } from "../../src/platform/usecase.js";

// A fake HostCtx.temporal: records started workflowIds, throws AlreadyStarted on a duplicate.
function fakeHost() {
  const started = new Set<string>();
  const calls: string[] = [];
  const temporal = {
    workflow: {
      async start(_wf: unknown, o: { workflowId: string }) {
        calls.push(o.workflowId);
        if (started.has(o.workflowId)) throw new WorkflowExecutionAlreadyStartedError("already started", o.workflowId, "wf");
        started.add(o.workflowId);
        return { workflowId: o.workflowId };
      },
    },
  };
  return { host: { temporal, connectors: {} } as unknown as HostCtx, calls };
}

const moduleFor = (tag: string): UseCaseModule => ({
  name: tag,
  workflows: {},
  activities: {},
  triggers: [{
    kind: "event", event: "employee.new-hire",
    start: async (payload, host) => { await host.temporal.workflow.start("wf", { taskQueue: "main", workflowId: `${tag}:${payload.employeeId}` }); },
  }],
});

const GOOD = "Basic good";
const opts = { verifyPaylocityAuth: (h: string | undefined) => h === GOOD };

describe("host ingress", () => {
  it("fans a valid new-hire event out to BOTH modules", async () => {
    const { host, calls } = fakeHost();
    const app = buildIngress([moduleFor("a"), moduleFor("b")], host, opts);
    const res = await app.inject({ method: "POST", url: "/webhooks/paylocity", headers: { authorization: GOOD }, payload: { companyId: "C1", employeeId: "E1" } });
    expect(res.statusCode).toBe(202);
    expect(calls).toEqual(["a:E1", "b:E1"]);
    await app.close();
  });

  it("401s a bad auth header and fires nothing", async () => {
    const { host, calls } = fakeHost();
    const app = buildIngress([moduleFor("a")], host, opts);
    const res = await app.inject({ method: "POST", url: "/webhooks/paylocity", headers: { authorization: "Basic wrong" }, payload: { companyId: "C1", employeeId: "E1" } });
    expect(res.statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("is idempotent — the same employeeId twice swallows AlreadyStarted as success", async () => {
    const { host, calls } = fakeHost();
    const app = buildIngress([moduleFor("a")], host, opts);
    const payload = { companyId: "C1", employeeId: "E1" };
    const r1 = await app.inject({ method: "POST", url: "/webhooks/paylocity", headers: { authorization: GOOD }, payload });
    const r2 = await app.inject({ method: "POST", url: "/webhooks/paylocity", headers: { authorization: GOOD }, payload });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    expect(calls).toEqual(["a:E1", "a:E1"]);  // called twice; the second threw AlreadyStarted and was swallowed
    await app.close();
  });
});
