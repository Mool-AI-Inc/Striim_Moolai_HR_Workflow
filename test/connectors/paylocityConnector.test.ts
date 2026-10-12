import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { PaylocityConnector } from "../../src/platform/connectors/paylocity/paylocityConnector.js";

describe("PaylocityConnector → simulator", () => {
  const employees = Array.from({ length: 30 }, (_, i) => makeEmployee({ employeeId: `E${i}`, email: `e${i}@instantteams.test` }));
  const app = buildSimulator(employees);
  let baseUrl: string;
  beforeAll(async () => { baseUrl = await app.listen({ port: 0, host: "127.0.0.1" }); });
  afterAll(async () => { await app.close(); });
  const conn = () => new PaylocityConnector({ baseUrl, clientId: "cid", clientSecret: "secret" });

  it("reads a single employee", async () => {
    expect((await conn().getEmployee("C1", "E7")).employeeId).toBe("E7");
  });
  it("paginates the full roster (30 over pagesize 25)", async () => {
    expect(await conn().listEmployees("C1")).toHaveLength(30);
  });
  it("verifies Basic-auth webhook headers (good, wrong, missing)", () => {
    const c = conn();
    expect(c.verifyWebhookAuth("Basic " + Buffer.from("cid:secret").toString("base64"))).toBe(true);
    expect(c.verifyWebhookAuth("Basic " + Buffer.from("cid:wrong").toString("base64"))).toBe(false);
    expect(c.verifyWebhookAuth(undefined)).toBe(false);
  });
  it("stages a new hire and returns an employeeId", async () => {
    const r = await conn().createEmployeeStaging({ companyId: "C1", firstName: "New", lastName: "Hire", email: "new.hire@instantteams.test" });
    expect(r.employeeId).toMatch(/^STG_/);
  });
});
