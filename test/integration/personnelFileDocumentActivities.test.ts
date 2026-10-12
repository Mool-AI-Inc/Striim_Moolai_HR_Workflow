/**
 * fileDocument ledger-idempotency tests against a real buildSimulator() + real Postgres (final audit finding).
 * @lifespan THROWAWAY — integration-tier test only; needs compose Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { migrate } from "../../src/platform/db/sendLedger.js";
import { getPool, closePool } from "../../src/platform/db/pool.js";
import type { ScreeningDoc } from "../../src/platform/domain/types.js";

// Same pattern as the other test/integration/*Activities.test.ts files: personnelFile/activities.ts builds
// its GoogleDriveConnector from loadEnv() at module-top-level, so point PLATFORM_MODE/SIMULATOR_URL at a real
// buildSimulator() on an ephemeral port BEFORE first import.
describe("fileDocument — ledger-idempotent (integration)", () => {
  let sim: FastifyInstance;
  let simUrl: string;
  let fileDocument: (folderId: string, doc: ScreeningDoc) => Promise<{ fileId: string }>;

  beforeAll(async () => {
    await migrate();
    await getPool().query(`TRUNCATE send_ledger, sms_opt_out`);
    sim = buildSimulator([]);
    simUrl = await sim.listen({ port: 0, host: "127.0.0.1" });
    process.env.SIMULATOR_URL = simUrl;
    process.env.PLATFORM_MODE = "demo";
    ({ fileDocument } = await import("../../src/usecases/personnelFile/activities.js"));
  });

  afterAll(async () => {
    await sim.close();
    await closePool();
  });

  it("files once; a second call for the same doc is deduped via the ledger, not re-uploaded to Drive", async () => {
    const doc: ScreeningDoc = { filename: "background-check-E-PF-DOC1.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) };

    const first = await fileDocument("folder-E-PF-DOC1", doc);
    expect(first.fileId).toBeTruthy();
    expect(first.fileId).not.toBe("skipped");

    const second = await fileDocument("folder-E-PF-DOC1", doc);
    expect(second).toEqual({ fileId: "skipped" });

    // A real Temporal activity retry (the Drive POST succeeds but the response is lost) must not re-upload —
    // exactly one file for this folder/doc, not two.
    const files = (await (await fetch(`${simUrl}/_files`)).json()) as { folderId: string; name: string }[];
    expect(files.filter((f) => f.folderId === "folder-E-PF-DOC1")).toHaveLength(1);
  });
});
