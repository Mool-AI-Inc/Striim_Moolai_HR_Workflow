import { describe, it, expect } from "vitest";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";

describe("simulator renders aligned documents on demand", () => {
  it("serves the requested employee's background-check as a valid PDF", async () => {
    const app = buildSimulator([makeEmployee({ employeeId: "EMP-DANA", firstName: "Dana", lastName: "Cole" })]);
    const res = await app.inject({ method: "GET", url: "/screening/SCR-EMP-DANA" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("serves the WorkBright I-9 for a known employee", async () => {
    const app = buildSimulator([makeEmployee({ employeeId: "EMP_7" })]);
    const res = await app.inject({ method: "GET", url: "/api/submissions/SUB-EMP_7/file" });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("falls back to a valid PDF for an unknown id", async () => {
    const app = buildSimulator([]);
    const res = await app.inject({ method: "GET", url: "/screening/SCR-NOPE" });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
