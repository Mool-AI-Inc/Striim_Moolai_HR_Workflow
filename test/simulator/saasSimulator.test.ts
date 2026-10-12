import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";

describe("SaaS simulator (Layer A double)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildSimulator([
      makeEmployee({ employeeId: "E1", email: "e1@instantteams.test" }),
      makeEmployee({ employeeId: "E2", email: "e2@instantteams.test" }),
    ]);
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it("issues a token, lists + reads employees with a total-count header", async () => {
    const tok = await app.inject({ method: "POST", url: "/IdentityServer/connect/token" });
    expect(tok.json().access_token).toBe("sim-token");
    const list = await app.inject({ method: "GET", url: "/api/v2/companies/C1/employees?pagesize=25&pagenumber=0&includetotalcount=true" });
    expect(list.headers["x-pcty-total-count"]).toBe("2");
    expect(list.json()).toHaveLength(2);
    const one = await app.inject({ method: "GET", url: "/api/v2/companies/C1/employees/E1" });
    expect(one.json().employeeId).toBe("E1");
    const miss = await app.inject({ method: "GET", url: "/api/v2/companies/C1/employees/NOPE" });
    expect(miss.statusCode).toBe(404);
  });

  it("records a template send; rejects an unknown alias with 422; force-fails once", async () => {
    const ok = await app.inject({ method: "POST", url: "/email/withTemplate", payload: { To: "e1@instantteams.test", TemplateAlias: "welcome", TemplateModel: {}, Metadata: { idempotencyKey: "k1" } } });
    expect(ok.json().ErrorCode).toBe(0);
    const uc4 = await app.inject({ method: "POST", url: "/email/withTemplate", payload: { To: "e1@instantteams.test", TemplateAlias: "uc4-report-ready", TemplateModel: {} } });
    expect(uc4.json().ErrorCode).toBe(0);  // a real alias, not a 422
    const bad = await app.inject({ method: "POST", url: "/email/withTemplate", payload: { To: "e1@instantteams.test", TemplateAlias: "nope", TemplateModel: {} } });
    expect(bad.statusCode).toBe(422);
    await app.inject({ method: "POST", url: "/_forceFail" });
    const boom = await app.inject({ method: "POST", url: "/email/withTemplate", payload: { To: "e1@instantteams.test", TemplateAlias: "welcome", TemplateModel: {} } });
    expect(boom.statusCode).toBe(500);
    const sent = await app.inject({ method: "GET", url: "/_sent" });
    expect(sent.json().length).toBe(2);  // the two ErrorCode:0 sends (uc4 + welcome); the 422 and 500 were not recorded
  });

  it("SMS send is recorded", async () => {
    const r = await app.inject({ method: "POST", url: "/sms/send", payload: { to: "+15555550100", body: "hi", idempotencyKey: "s1" } });
    expect(r.json().MessageID).toMatch(/^sms-/);
    expect((await app.inject({ method: "GET", url: "/_sms" })).json().length).toBe(1);
  });

  it("Slack invite is idempotent by email", async () => {
    const first = await app.inject({ method: "POST", url: "/admin.users.invite", payload: { email: "e1@instantteams.test", channelIds: ["C"], kind: "member" } });
    expect(first.json().already).toBe(false);
    const second = await app.inject({ method: "POST", url: "/admin.users.invite", payload: { email: "e1@instantteams.test", channelIds: ["C"], kind: "member" } });
    expect(second.json().already).toBe(true);
    expect((await app.inject({ method: "GET", url: "/_invites" })).json()).toContain("e1@instantteams.test");
  });

  it("screening + submission return non-empty application/pdf", async () => {
    const s = await app.inject({ method: "GET", url: "/screening/abc" });
    expect(s.headers["content-type"]).toContain("application/pdf");
    expect(s.rawPayload.length).toBeGreaterThan(0);
    const wb = await app.inject({ method: "GET", url: "/api/submissions/xyz/file" });
    expect(wb.headers["content-type"]).toContain("application/pdf");
    expect(wb.rawPayload.length).toBeGreaterThan(0);
  });

  it("Drive putFile returns a fileId and records it", async () => {
    const r = await app.inject({ method: "POST", url: "/files", payload: { folderId: "locked", name: "personnel.pdf", contentType: "application/pdf" } });
    expect(r.json().fileId).toMatch(/^file-/);
    expect((await app.inject({ method: "GET", url: "/_files" })).json().length).toBe(1);
  });

  it("Weblink staging returns a new employeeId", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v2/companies/C1/employees", payload: { firstName: "New", lastName: "Hire", email: "new.hire@instantteams.test" } });
    expect(r.json().employeeId).toMatch(/^STG_/);
  });

  it("packet assign + EN send drop receipts visible in inspection hooks", async () => {
    const asg = await app.inject({ method: "POST", url: "/packets/E1/assign", payload: { packetId: "PKT-RFT-ENG" } });
    expect(asg.json().receiptId).toMatch(/^asg-/);
    expect((await app.inject({ method: "GET", url: "/_assignments" })).json()[0]).toMatchObject({ employeeId: "E1", packetId: "PKT-RFT-ENG" });
    const en = await app.inject({ method: "POST", url: "/en/E1/send" });
    expect(en.json().receiptId).toMatch(/^en-/);
    expect((await app.inject({ method: "GET", url: "/_ensends" })).json()[0]).toMatchObject({ employeeId: "E1" });
  });
});
