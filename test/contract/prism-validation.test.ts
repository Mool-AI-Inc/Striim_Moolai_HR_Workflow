import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { PaylocityConnector } from "../../src/platform/connectors/paylocity/paylocityConnector.js";
import { PostmarkCommsConnector } from "../../src/platform/connectors/comms/postmarkCommsConnector.js";

// Layer C — contract fidelity. Prism proxies connector → simulator, validating each request/response against the
// hand-authored OpenAPI. CI/dev-only (THROWAWAY): the specs + prism never run on the prod VM.
const PRISM_BIN = fileURLToPath(new URL("../../node_modules/.bin/prism", import.meta.url));
const PAYLOCITY_SPEC = fileURLToPath(new URL("../../specs/openapi/paylocity.trimmed.yaml", import.meta.url));
const POSTMARK_SPEC = fileURLToPath(new URL("../../specs/openapi/postmark.trimmed.yaml", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}
function spawnPrism(spec: string, upstream: string, port: number) {
  return execa(PRISM_BIN, ["proxy", spec, upstream, "--errors", "-p", String(port), "-h", "127.0.0.1"], { reject: false });
}
type PrismProc = ReturnType<typeof spawnPrism>;
async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 120; i++) {                                 // up to 60s — any HTTP response means prism is up
    try { await fetch(`http://127.0.0.1:${port}/__ping`); return; } catch { await sleep(500); }
  }
  throw new Error(`prism did not start on :${port}`);
}

describe("contract fidelity (Prism, CI-only)", () => {
  let sim: FastifyInstance;
  let simUrl: string;
  let paylocityProxy: string, postmarkProxy: string;
  let p1: PrismProc, p2: PrismProc;

  beforeAll(async () => {
    sim = buildSimulator([makeEmployee({ employeeId: "E0", email: "e0@instantteams.test" })]);
    simUrl = await sim.listen({ port: 0, host: "127.0.0.1" });
    const [pp, mp] = await Promise.all([freePort(), freePort()]);
    p1 = spawnPrism(PAYLOCITY_SPEC, simUrl, pp);
    p2 = spawnPrism(POSTMARK_SPEC, simUrl, mp);
    await Promise.all([waitReady(pp), waitReady(mp)]);
    paylocityProxy = `http://127.0.0.1:${pp}`;
    postmarkProxy = `http://127.0.0.1:${mp}`;
  }, 90_000);

  afterAll(async () => {
    p1?.kill("SIGKILL"); p2?.kill("SIGKILL");
    await sim?.close();
  });

  it("a valid PaylocityConnector read proxies through Prism and validates", async () => {
    const conn = new PaylocityConnector({ baseUrl: paylocityProxy, clientId: "cid", clientSecret: "secret" });
    expect((await conn.getEmployee("C1", "E0")).employeeId).toBe("E0");
  }, 30_000);

  it("a malformed request (integer param = 'abc') is rejected by Prism with a 4xx", async () => {
    const res = await fetch(`${paylocityProxy}/api/v2/companies/C1/employees?pagenumber=abc`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }, 30_000);

  it("the connector actually sends X-Postmark-Server-Token (Prism --errors would not flag its absence)", async () => {
    const conn = new PostmarkCommsConnector({ baseUrl: postmarkProxy, serverToken: "tok-123", from: "hr@instant.test" });
    await conn.sendTransactional({ to: "e0@instantteams.test", templateAlias: "welcome", model: {}, idempotencyKey: "c1" });
    const headers = await (await fetch(`${simUrl}/_lastHeaders`)).json() as Record<string, string>;
    expect(headers["x-postmark-server-token"]).toBe("tok-123");
  }, 30_000);
});
