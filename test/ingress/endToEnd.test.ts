import { describe, it, expect } from "vitest";
import { buildIngress } from "../../src/platform/ingress.js";
import { MODULES } from "../../src/platform/registry.js";
import { mergeActivities } from "../../src/platform/worker.js";
import type { HostCtx, UseCaseModule } from "../../src/platform/usecase.js";

function recordingHost() {
  const started: string[] = [];
  const host = { temporal: { workflow: { start: async (_wf: unknown, o: { workflowId: string }) => { started.push(o.workflowId); return {}; } } }, connectors: {} } as unknown as HostCtx;
  return { host, started };
}
const fanout = (modules: readonly UseCaseModule[], host: HostCtx, event: string, employeeId: string) =>
  buildIngress(modules, host, { verifyPaylocityAuth: () => true })
    .inject({ method: "POST", url: event === "employee.new-hire" ? "/webhooks/paylocity" : "/webhooks/task-complete",
      payload: { companyId: "C1", employeeId } });

describe("end-to-end wiring over the real registry", () => {
  it("new-hire fans out to BOTH newHireLifecycle and packetSelection (no import between them)", async () => {
    const { host, started } = recordingHost();
    await fanout(MODULES, host, "employee.new-hire", "E1");
    expect(started.sort()).toEqual(["newhire:E1", "packet:E1"]);
  });

  it("task-complete now starts personnelFile (Plan-3 wired); the three recurring scans are scheduled", async () => {
    const { host, started } = recordingHost();
    await fanout(MODULES, host, "employee.task-complete", "E1");
    expect(started).toEqual(["personnel:E1"]);                    // personnelFile (UC3) consumes employee.task-complete
    const schedules = MODULES.flatMap((m) => m.triggers ?? []).filter((t) => t.kind === "schedule");
    expect(schedules.map((t) => t.id).sort())
      .toEqual(["birthdayAnniversaryScan", "monthlyFinanceReport", "startingSoonScan"]);  // UC5 / UC4 / UC8
  });

  it("mounts the module webhook triggers (SMS STOP route is wired)", async () => {
    const { host } = recordingHost();
    const app = buildIngress(MODULES, host, { verifyPaylocityAuth: () => true });
    // The handler itself writes to Postgres (recordOptOut) — a runtime concern, not a wiring one. This unit-tier
    // test proves the host MOUNTS the module's webhook trigger: a mounted route is anything but 404 (404 = unrouted).
    const r = await app.inject({ method: "POST", url: "/webhooks/sms/stop", payload: { phone: "+15555550100" } });
    expect(r.statusCode).not.toBe(404);
  });

  // ── the modularity proof ────────────────────────────────────────────────
  it("REMOVE = drop a line: without packetSelection, new-hire fans out to only newhire, and its activities vanish", async () => {
    const reduced = MODULES.filter((m) => m.name !== "packetSelection");
    const { host, started } = recordingHost();
    await fanout(reduced, host, "employee.new-hire", "E1");
    expect(started).toEqual(["newhire:E1"]);
    const names = Object.keys(mergeActivities(reduced));
    expect(names).not.toContain("recommendPacket");
    expect(names).not.toContain("assignPacket");
    expect(names).toContain("sendSms");                          // the other modules are untouched
  });
});
