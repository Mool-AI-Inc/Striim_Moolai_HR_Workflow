/**
 * packetSelection activities — recommend (HRIS + recommender) and assign (file-drop).
 * @lifespan PRODUCTION — the recommend path; the file-drop connector behind assignPacket is the robot stand-in.
 * @responsibility Resolve the employee + recommend a packet; drop the assignment via the connector.
 */
import { loadEnv } from "../../platform/config/env.js";
import { PaylocityConnector } from "../../platform/connectors/paylocity/paylocityConnector.js";
import { FileDropPacketConnector } from "./connectors/fileDropPacketConnector.js";
import { RulePacketRecommender, LlmPacketRecommender } from "./packetRecommender.js";
import type { PacketRecommender } from "../../platform/connectors/types.js";
import type { PacketRecommendation } from "../../platform/domain/types.js";

const env = loadEnv();
const hris = new PaylocityConnector(env.paylocity);
const packet = new FileDropPacketConnector({ baseUrl: env.simulatorUrl });                 // file-drop targets the simulator in both modes
const recommender: PacketRecommender = env.anthropicApiKey
  ? new LlmPacketRecommender({ apiKey: env.anthropicApiKey, model: env.uc6Model ?? "claude-haiku-4-5-20251001" })
  : new RulePacketRecommender();

export async function recommendPacket(companyId: string, employeeId: string): Promise<PacketRecommendation> {
  const e = await hris.getEmployee(companyId, employeeId);
  return recommender.recommend(e);
}
export async function assignPacket(_companyId: string, employeeId: string, packetId: string, docs: string[]): Promise<{ receiptId: string }> {
  return packet.assignPacket(employeeId, packetId, docs);
}
