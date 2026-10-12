import { describe, it, expect } from "vitest";
import { MODULES } from "../../src/platform/registry.js";
import { mergeActivities } from "../../src/platform/worker.js";
import * as bundle from "../../src/platform/workflows.bundle.js";

describe("registry — the canonical seven modules", () => {
  it("registers exactly the canonical seven module names", () => {
    expect(MODULES.map((m) => m.name).sort())
      .toEqual([
        "benefitsDay60Send", "birthdayAnniversaryScan", "monthlyFinanceReport",
        "newHireLifecycle", "packetSelection", "personnelFile", "startingSoonScan",
      ]);
  });
  it("re-exports each module workflow from the bundle (so the worker + child-by-name resolve)", () => {
    for (const w of [
      "newHireLifecycle", "packetSelection", "benefitsDay60Send",
      "birthdayAnniversaryScan", "startingSoonScan", "monthlyFinanceReport", "personnelFile",
    ])
      expect(typeof (bundle as Record<string, unknown>)[w]).toBe("function");
  });
  it("merges the module activities with the shared ones, no collision", () => {
    const names = Object.keys(mergeActivities(MODULES));
    for (const a of ["sendSms", "recommendPacket", "assignPacket", "stageSend", "inviteToSlack", "writeFinanceReport"]) expect(names).toContain(a);
    for (const a of ["fetchBackgroundCheck", "fetchI9", "fileDocument", "createEmployeeStaging"]) expect(names).toContain(a);
    for (const a of ["sendEmail", "getEmployee", "registerPending", "resolvePending", "alarmDidNotSend"]) expect(names).toContain(a);
  });
});
