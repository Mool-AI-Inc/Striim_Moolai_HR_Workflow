import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { FileDropEnConnector } from "../../src/usecases/benefitsDay60Send/connectors/fileDropEnConnector.js";

describe("FileDropEnConnector → simulator (Layer A)", () => {
  const app = buildSimulator([]);
  let baseUrl: string;
  beforeAll(async () => { baseUrl = await app.listen({ port: 0, host: "127.0.0.1" }); });
  afterAll(async () => { await app.close(); });

  it("stages an EN send and the simulator records it", async () => {
    const en = new FileDropEnConnector({ baseUrl });
    const r = await en.stageSend("E1");
    expect(r.receiptId).toBeTruthy();
    const recorded = await app.inject({ method: "GET", url: "/_ensends" });
    expect(recorded.json()).toHaveLength(1);
    expect(recorded.json()[0]).toMatchObject({ employeeId: "E1" });
  });
});
