import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packetFor, expectedPacketId, guards, ALL_PACKETS } from "../../../src/usecases/packetSelection/decisionTable.js";
import { loadDemoEmployees, makeEmployee } from "../../../src/synthdata/scenarios.js";

describe("UC6 decision table", () => {
  it("composes the frozen packetId + label from type × costCenter", () => {
    const p = packetFor(makeEmployee({ employeeType: "RFT", costCenter: "CC-ENG" }));
    expect(p.packetId).toBe("PKT-RFT-ENG");
    expect(p.label).toBe("Regular Full-Time · ENG");
    expect(p.baseTier).toBe("RFT");
    expect(p.overlay).toBe("CC-ENG");
    expect(expectedPacketId(makeEmployee({ employeeType: "SNL", costCenter: "CC-RETAIL" }))).toBe("PKT-SNL-RETAIL");
  });

  it("requiredDocs = base-tier docs ++ department overlay, in order", () => {
    const p = packetFor(makeEmployee({ employeeType: "SNL", costCenter: "CC-ENG" }));
    expect(p.requiredDocs).toContain("end-date-ack");     // SNL base
    expect(p.requiredDocs).toContain("ip-assignment");    // CC-ENG overlay
    // base precedes overlay
    expect(p.requiredDocs.indexOf("end-date-ack")).toBeLessThan(p.requiredDocs.indexOf("ip-assignment"));
  });

  it("ALL_PACKETS is the 12-packet canonical library with unique, well-formed ids", () => {
    expect(ALL_PACKETS).toHaveLength(12);
    const ids = ALL_PACKETS.map((p) => p.packetId);
    expect(new Set(ids).size).toBe(12);
    expect(ids.every((id) => /^PKT-(RFT|RPT|SNL)-(RETAIL|OPS|CX|ENG)$/.test(id))).toBe(true);
    expect(ids).toContain("PKT-SNL-ENG");                 // the intended phantom (spec §E)
  });

  it("guards surface non-blocking flags without changing the id", () => {
    expect(guards(makeEmployee({ employeeType: "RFT", costCenter: "CC-OPS", status: "A" }))).toEqual([]);
    expect(guards(makeEmployee({ status: "T" })).some((f) => f.includes("status"))).toBe(true);
    expect(guards(makeEmployee({ employeeType: "SNL", costCenter: "CC-ENG" })).some((f) => f.includes("SNL"))).toBe(true);
    // guards never alter the packet id
    expect(expectedPacketId(makeEmployee({ employeeType: "SNL", costCenter: "CC-ENG", status: "T" }))).toBe("PKT-SNL-ENG");
  });

  it("the library covers the whole generated population (every row → a real packet)", () => {
    const ids = new Set(ALL_PACKETS.map((p) => p.packetId));
    for (const e of loadDemoEmployees()) {
      expect(ids.has(expectedPacketId(e))).toBe(true);
      expect(packetFor(e).requiredDocs.length).toBeGreaterThan(0);
    }
  });

  it("the committed fixture deep-equals the code (no drift)", () => {
    const path = fileURLToPath(new URL("../../../fixtures/packets/index.json", import.meta.url));
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed).toEqual(ALL_PACKETS);
  });
});
