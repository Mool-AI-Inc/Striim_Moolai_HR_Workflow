import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { FileDropPacketConnector } from "../../src/usecases/packetSelection/connectors/fileDropPacketConnector.js";

describe("FileDropPacketConnector → simulator (Layer A)", () => {
  const app = buildSimulator([]);
  let baseUrl: string;
  beforeAll(async () => { baseUrl = await app.listen({ port: 0, host: "127.0.0.1" }); });
  afterAll(async () => { await app.close(); });

  it("drops an assignment with the chosen docs and the simulator records it", async () => {
    const packet = new FileDropPacketConnector({ baseUrl });
    const docs = ["I-9", "W-4", "ip-assignment"];
    const r = await packet.assignPacket("E1", "PKT-RFT-ENG", docs);
    expect(r.receiptId).toBeTruthy();
    const recorded = await app.inject({ method: "GET", url: "/_assignments" });
    expect(recorded.json()).toHaveLength(1);
    expect(recorded.json()[0]).toMatchObject({ employeeId: "E1", packetId: "PKT-RFT-ENG", docs });
  });
});
