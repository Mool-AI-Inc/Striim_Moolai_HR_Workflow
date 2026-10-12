import { describe, it, expect } from "vitest";
import { documentLines, renderDocument } from "../../simulator/documentGenerator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { packetFor } from "../../src/usecases/packetSelection/decisionTable.js";

const dana = makeEmployee({
  employeeId: "EMP-DANA", firstName: "Dana", lastName: "Cole",
  birthDate: "1990-04-12", hireDate: "2026-08-20", employeeType: "RFT", costCenter: "CC-ENG",
});

describe("demo document generator — content is aligned to the employee", () => {
  it("background-check carries the candidate identity", () => {
    const L = documentLines("background-check", dana).join("\n");
    expect(L).toContain("Dana Cole");
    expect(L).toContain("1990-04-12");
    expect(L).toContain("BGC-EMP-DANA");
    expect(L).toContain("CLEAR");
  });

  it("I-9 carries hire/type/cost-center and the employee's UC6 packet", () => {
    const L = documentLines("I-9", dana).join("\n");
    expect(L).toContain("Dana Cole");
    expect(L).toContain("2026-08-20");
    expect(L).toContain("Regular Full-Time");
    expect(L).toContain("CC-ENG");
    expect(L).toContain(packetFor(dana).packetId);          // "PKT-RFT-ENG"
    expect(L).toContain(packetFor(dana).requiredDocs[0]);   // a real required doc from the packet
  });

  it("benefits-summary reflects the plan tier and Day-60 eligibility", () => {
    const L = documentLines("benefits-summary", dana).join("\n");
    expect(L).toContain("Full-time benefits");
    expect(L).toContain("2026-10-19");                       // 2026-08-20 + 60 days
    expect(L).toContain("CC-ENG");
  });

  it("plan tier tracks employeeType", () => {
    const snl = documentLines("benefits-summary", makeEmployee({ employeeType: "SNL" })).join("\n");
    expect(snl).toContain("Seasonal — benefits not applicable");
  });

  it("renders every packet doc — universal + overlay — with a title and the employee's identity", () => {
    const w4 = documentLines("W-4", dana).join("\n");
    expect(w4).toContain("Form W-4");
    expect(w4).toContain("Dana Cole");
    const ip = documentLines("ip-assignment", dana).join("\n");
    expect(ip).toContain("Intellectual Property Assignment");
    expect(ip).toContain("CC-ENG");
  });

  it("falls back to a generic acknowledgment for an unspecced doc id", () => {
    const L = documentLines("some-new-policy", dana).join("\n");
    expect(L).toContain("Some New Policy");     // title-cased
    expect(L).toContain("Acknowledgment");
    expect(L).toContain("Dana Cole");
  });

  it("renderDocument returns a valid, non-trivial PDF", async () => {
    const bytes = await renderDocument("I-9", dana);
    expect(bytes.length).toBeGreaterThan(400);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
  });
});
