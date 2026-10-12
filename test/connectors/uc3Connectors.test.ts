/**
 * UC3 Vetty/WorkBright/Drive connector tests against a real buildSimulator() instance on an ephemeral port.
 * @lifespan THROWAWAY — unit-tier test only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { VettyConnector } from "../../src/usecases/personnelFile/connectors/vettyConnector.js";
import { WorkBrightConnector } from "../../src/usecases/personnelFile/connectors/workBrightConnector.js";
import { GoogleDriveConnector } from "../../src/usecases/personnelFile/connectors/driveConnector.js";

// @ts-expect-error — GoogleDriveConnector intentionally has NO setPermissions (spec §8: automation never changes sharing)
type _NoPerms = Parameters<GoogleDriveConnector["setPermissions"]>;

describe("UC3 document connectors → simulator", () => {
  const app = buildSimulator([makeEmployee({ employeeId: "E1" })]);
  let baseUrl: string;
  beforeAll(async () => { baseUrl = await app.listen({ port: 0, host: "127.0.0.1" }); });
  afterAll(async () => { await app.close(); });

  it("VettyConnector.getScreening returns non-empty application/pdf bytes", async () => {
    const conn = new VettyConnector({ baseUrl, token: "tok" });
    const doc = await conn.getScreening("SCR1");
    expect(doc.contentType).toBe("application/pdf");
    expect(doc.bytes.length).toBeGreaterThan(0);
  });

  it("WorkBrightConnector.getSubmissionFile returns non-empty application/pdf bytes", async () => {
    const conn = new WorkBrightConnector({ baseUrl, token: "tok" });
    const doc = await conn.getSubmissionFile("SUB1");
    expect(doc.contentType).toBe("application/pdf");
    expect(doc.bytes.length).toBeGreaterThan(0);
  });

  it("GoogleDriveConnector.putFile round-trips folder/name and returns a fileId", async () => {
    const conn = new GoogleDriveConnector({ baseUrl, token: "tok" });
    // dynamic generation is the one document strategy (spec §S1) — pull real PDF bytes from the simulator, not a static fixture
    const src = await new VettyConnector({ baseUrl, token: "tok" }).getScreening("SCR1");
    const { fileId } = await conn.putFile("FOLDER1", "background-check-E1.pdf", src.bytes, "application/pdf");
    expect(fileId).toMatch(/^file-/);
    const files = (await (await fetch(`${baseUrl}/_files`)).json()) as Array<{ folderId: string; name: string }>;
    expect(files.at(-1)).toEqual({ folderId: "FOLDER1", name: "background-check-E1.pdf" });
  });

  it("GoogleDriveConnector exposes only putFile — no setPermissions on the instance", () => {
    const conn = new GoogleDriveConnector({ baseUrl, token: "tok" });
    expect((conn as unknown as Record<string, unknown>).setPermissions).toBeUndefined();
  });

  it("the dynamically generated documents are non-empty, valid-looking PDFs", async () => {
    const vetty = await new VettyConnector({ baseUrl, token: "tok" }).getScreening("SCR1");
    const wb = await new WorkBrightConnector({ baseUrl, token: "tok" }).getSubmissionFile("SUB1");
    for (const doc of [vetty, wb]) {
      expect(Buffer.from(doc.bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(doc.bytes.length).toBeGreaterThan(100);
    }
  });
});
