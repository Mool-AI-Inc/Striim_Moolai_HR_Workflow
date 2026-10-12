/**
 * UC6 model bake-off — score candidate models against the decision-table oracle.
 * @lifespan THROWAWAY — dev-only; run manually to pick the cheapest sufficient model. Needs ANTHROPIC_API_KEY.
 * @responsibility Run each candidate LlmPacketRecommender over the population; report accuracy vs. expectedPacketId + latency.
 */
import { loadDemoEmployees } from "../src/synthdata/scenarios.js";
import { expectedPacketId, guards } from "../src/usecases/packetSelection/decisionTable.js";
import { LlmPacketRecommender } from "../src/usecases/packetSelection/packetRecommender.js";

const MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-5"];   // add "claude-opus-5" to see the ceiling
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("set ANTHROPIC_API_KEY to run the bake-off");
const clearCut = loadDemoEmployees().filter((e) => guards(e).length === 0);
for (const model of MODELS) {
  const rec = new LlmPacketRecommender({ apiKey, model }); let hits = 0; const misses: string[] = []; const t0 = Date.now();
  for (const e of clearCut) {
    const r = await rec.recommend(e);
    r.packetId === expectedPacketId(e) ? hits++ : misses.push(`${e.employeeId}: got ${r.packetId}, want ${expectedPacketId(e)}`);
  }
  console.log(`\n${model}: ${hits}/${clearCut.length} (${((hits / clearCut.length) * 100).toFixed(1)}%) in ${Date.now() - t0}ms`);
  if (misses.length) console.log("  misses:\n   " + misses.join("\n   "));
}
