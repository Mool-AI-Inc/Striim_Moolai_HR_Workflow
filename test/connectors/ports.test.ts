import { describe, it, expect } from "vitest";
import type { DriveConnector } from "../../src/platform/connectors/types.js";
import type { EmployeeRecord } from "../../src/platform/domain/types.js";  // Task 3 stays self-contained — no forward ref to Task 4's scenarios helper
import { InMemoryComms } from "../../src/platform/connectors/fakes/inMemoryComms.js";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";
// @ts-expect-error — DriveConnector intentionally has NO setPermissions (spec §8: automation never changes sharing)
type _NoPerms = Parameters<DriveConnector["setPermissions"]>;
describe("shared fakes (Layer B)", () => {
  it("InMemoryComms records a send; InMemoryHris serves a seeded employee", async () => {
    const comms = new InMemoryComms();
    await comms.sendTransactional({ to: "e1@instantteams.test", templateAlias: "welcome", model: {}, idempotencyKey: "k1" });
    expect(comms.sent).toHaveLength(1);
    const e1: EmployeeRecord = {
      employeeId: "E1", firstName: "Test", lastName: "Person", email: "e1@instantteams.test",
      birthDate: "1990-01-01", hireDate: "2022-01-01", employeeType: "RFT", status: "A",
      costCenter: "CC-OPS", phone: "+15555550100", smsConsent: true,
    };
    const hris = new InMemoryHris([e1]);
    expect((await hris.getEmployee("C1", "E1")).employeeId).toBe("E1");
  });
});
