/**
 * UC6 packet recommender — the decision table applied per employee.
 * @lifespan PRODUCTION — the recommend path; RulePacketRecommender doubles as the offline CI oracle.
 * @responsibility Turn an employee record into a {packetId, rationale, confidence, flags} recommendation.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EmployeeRecord, PacketRecommendation } from "../../platform/domain/types.js";
import type { PacketRecommender } from "../../platform/connectors/types.js";
import { packetFor, guards, ALL_PACKETS } from "./decisionTable.js";

export class RulePacketRecommender implements PacketRecommender {          // = the oracle; offline; the no-API fallback
  async recommend(e: EmployeeRecord): Promise<PacketRecommendation> {
    const p = packetFor(e); const flags = guards(e);
    return { packetId: p.packetId, rationale: `${e.employeeType} in ${e.costCenter} → ${p.label}`, confidence: flags.length ? 0.6 : 1, flags };
  }
}

export class LlmPacketRecommender implements PacketRecommender {           // model injected (cheapest-first)
  private readonly client: Pick<Anthropic, "messages">;
  constructor(private readonly opts: { apiKey: string; model: string; client?: Pick<Anthropic, "messages"> }) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  }
  async recommend(e: EmployeeRecord): Promise<PacketRecommendation> {
    const policy = ALL_PACKETS.map((p) => `${p.packetId}: ${p.label} — ${p.requiredDocs.join(", ")}`).join("\n");
    const msg = await this.client.messages.create({
      model: this.opts.model, max_tokens: 400,
      tools: [{ name: "packet", description: "Return the selected packet.", input_schema: { type: "object",
        required: ["packetId", "rationale", "confidence", "flags"], properties: {
          packetId: { type: "string" }, rationale: { type: "string" }, confidence: { type: "number" }, flags: { type: "array", items: { type: "string" } } } } }],
      tool_choice: { type: "tool", name: "packet" },
      system: `You are an HR onboarding assistant. Choose exactly one packet by applying this policy (packetId = PKT-<employeeType>-<costCenter without the CC- prefix>). Set confidence in [0,1]; list concerns as flags.\nPolicy:\n${policy}`,
      messages: [{ role: "user", content: JSON.stringify({ employeeType: e.employeeType, costCenter: e.costCenter, status: e.status, hireDate: e.hireDate }) }],
    });
    const use = msg.content.find((b) => b.type === "tool_use");
    if (!use || use.type !== "tool_use") throw new Error("LLM returned no packet selection");
    return use.input as PacketRecommendation;
  }
}
