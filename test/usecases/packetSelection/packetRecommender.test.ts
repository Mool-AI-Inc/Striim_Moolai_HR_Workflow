import { describe, it, expect } from "vitest";
import { RulePacketRecommender, LlmPacketRecommender } from "../../../src/usecases/packetSelection/packetRecommender.js";
import { expectedPacketId } from "../../../src/usecases/packetSelection/decisionTable.js";
import { loadDemoEmployees, makeEmployee } from "../../../src/synthdata/scenarios.js";

describe("packet recommenders", () => {
  it("RulePacketRecommender matches the oracle for every population row", async () => {
    const rec = new RulePacketRecommender();
    for (const e of loadDemoEmployees()) {
      const r = await rec.recommend(e);
      expect(r.packetId).toBe(expectedPacketId(e));
    }
  });

  it("RulePacketRecommender surfaces guard flags + lower confidence on the SNL×ENG edge", async () => {
    const r = await new RulePacketRecommender().recommend(makeEmployee({ employeeType: "SNL", costCenter: "CC-ENG" }));
    expect(r.packetId).toBe("PKT-SNL-ENG");
    expect(r.flags.length).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThan(1);
  });

  it("LlmPacketRecommender maps an injected tool_use block to a PacketRecommendation (offline)", async () => {
    const fakeClient = {
      messages: { create: async () => ({ content: [{ type: "tool_use", name: "packet",
        input: { packetId: "PKT-RFT-ENG", rationale: "RFT in ENG", confidence: 0.9, flags: [] } }] }) },
    } as unknown as import("@anthropic-ai/sdk").default;
    const rec = new LlmPacketRecommender({ apiKey: "x", model: "claude-haiku-4-5-20251001", client: fakeClient });
    const r = await rec.recommend(makeEmployee({ employeeType: "RFT", costCenter: "CC-ENG" }));
    expect(r.packetId).toBe("PKT-RFT-ENG");
    expect(r.confidence).toBeCloseTo(0.9);
  });
});
