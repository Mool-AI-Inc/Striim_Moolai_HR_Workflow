import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { PostmarkCommsConnector, PostmarkPermanentError } from "../../src/platform/connectors/comms/postmarkCommsConnector.js";

describe("PostmarkCommsConnector → simulator", () => {
  const app = buildSimulator([makeEmployee({ employeeId: "E1" })]);
  let baseUrl: string;
  beforeAll(async () => { baseUrl = await app.listen({ port: 0, host: "127.0.0.1" }); });
  afterAll(async () => { await app.close(); });
  const conn = () => new PostmarkCommsConnector({ baseUrl, serverToken: "tok", from: "hr@instant.test" });

  it("sends a welcome and the simulator records it", async () => {
    const r = await conn().sendTransactional({ to: "e1@instantteams.test", templateAlias: "welcome", model: {}, idempotencyKey: "k1" });
    expect(r.messageId).toBeTruthy();
    const sent = await app.inject({ method: "GET", url: "/_sent" });
    expect(sent.json().some((s: { TemplateAlias: string }) => s.TemplateAlias === "welcome")).toBe(true);
  });

  it("throws PostmarkPermanentError on an unknown alias (422)", async () => {
    await expect(
      // @ts-expect-error — intentionally an invalid alias to exercise the 422 → permanent path
      conn().sendTransactional({ to: "e1@instantteams.test", templateAlias: "not-a-real-alias", model: {}, idempotencyKey: "k2" }),
    ).rejects.toThrow(PostmarkPermanentError);
  });

  it("throws a plain retryable Error (not permanent) on a forced 500", async () => {
    await app.inject({ method: "POST", url: "/_forceFail" });
    const err = await conn().sendTransactional({ to: "e1@instantteams.test", templateAlias: "welcome", model: {}, idempotencyKey: "k3" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PostmarkPermanentError);
  });
});
