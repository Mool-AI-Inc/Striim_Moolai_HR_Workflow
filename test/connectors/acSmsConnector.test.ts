import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { AcSmsConnector } from "../../src/usecases/newHireLifecycle/connectors/acSmsConnector.js";

describe("AcSmsConnector → simulator (Layer A)", () => {
  const app = buildSimulator([]);
  let baseUrl: string;
  beforeAll(async () => { baseUrl = await app.listen({ port: 0, host: "127.0.0.1" }); });
  afterAll(async () => { await app.close(); });

  it("posts a text and the simulator records it", async () => {
    const sms = new AcSmsConnector({ baseUrl, apiToken: "demo" });
    const r = await sms.sendSms({ to: "+15555550100", body: "welcome-sms", idempotencyKey: "k1" });
    expect(r.messageId).toBeTruthy();                                  // requires the MessageID→messageId mapping
    const recorded = await app.inject({ method: "GET", url: "/_sms" });
    expect(recorded.json()).toHaveLength(1);
    expect(recorded.json()[0]).toMatchObject({ to: "+15555550100" });
  });
});
