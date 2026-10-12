/**
 * SaaS simulator — the shared Layer-A test double every module's real-connector test points at.
 * @lifespan THROWAWAY — dev/CI/demo only; never runs on the prod VM (there, connectors hit real vendors).
 * @responsibility Stand in for every vendor API (Paylocity, Postmark, SMS, Slack, Vetty, WorkBright, Drive,
 *   packet-assign, EN-send) with just enough behavior for the connectors + inspection hooks for the tests.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import type { EmployeeRecord } from "../src/platform/domain/types.js";
// Documents are rendered on demand from the employee store (spec: demo-documents). No committed PDFs.
import { renderDocument } from "./documentGenerator.js";

// The five accepted Postmark EMAIL aliases (welcome-sms is an SMS template, not an email one).
const EMAIL_ALIASES = new Set(["welcome", "day60-compliance", "birthday", "anniversary", "uc4-report-ready", "onboarding-packet"]);

type Body = Record<string, unknown>;

export function buildSimulator(employees: EmployeeRecord[]): FastifyInstance {
  const app = Fastify();
  // Paylocity's token endpoint is form-urlencoded; Fastify has no parser for it by default (would 415).
  // The token handler ignores the body, so accept it as a raw string. Avoids a new @fastify/formbody dep.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));
  // Capture the last non-inspection request's headers (the Prism contract test asserts the connector sends its
  // auth token — Prism --errors won't flag a missing required header, so we verify it was actually sent).
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  app.addHook("onRequest", async (req) => { if (!req.url.startsWith("/_")) lastHeaders = req.headers; });
  app.get("/_lastHeaders", async () => lastHeaders);
  const emp: EmployeeRecord[] = [...employees];
  // Resolve a document fetch id (SCR-<id> / SUB-<id>) back to its employee; unknown ids fall back to a sample.
  const DOC_PLACEHOLDER: EmployeeRecord = {
    employeeId: "EMP-SAMPLE", firstName: "Sample", lastName: "Employee",
    email: "sample.employee@instantteams.test", birthDate: "1990-01-01", hireDate: "2022-01-01",
    employeeType: "RFT", status: "A", costCenter: "CC-OPS", phone: "+15555550100", smsConsent: false,
  };
  const docEmp = (id: string, prefix: RegExp): EmployeeRecord =>
    emp.find((e) => e.employeeId === id.replace(prefix, "")) ?? DOC_PLACEHOLDER;
  const sent: Body[] = [], sms: Body[] = [], files: Body[] = [], assignments: Body[] = [], ensends: Body[] = [];
  const invited = new Set<string>();
  const sheets: { spreadsheetId: string; rowCount: number; highlightedCount: number }[] = [];   // UC4 report sink
  let forceFailOnce = false;
  let stagedSeq = 0;

  // ── Paylocity (Weblink) ──────────────────────────────────────────────────
  app.post("/IdentityServer/connect/token", async () =>
    ({ access_token: "sim-token", token_type: "Bearer", expires_in: 3600 }));

  app.get("/api/v2/companies/:companyId/employees", async (req, reply) => {
    const q = req.query as Body;
    const pagesize = Number(q.pagesize ?? 25);
    const pagenumber = Number(q.pagenumber ?? 0);  // 0-based
    reply.header("X-Pcty-Total-Count", String(emp.length));
    return emp.slice(pagenumber * pagesize, (pagenumber + 1) * pagesize);
  });

  app.get("/api/v2/companies/:companyId/employees/:employeeId", async (req, reply) => {
    const { employeeId } = req.params as { employeeId: string };
    const found = emp.find((e) => e.employeeId === employeeId);
    if (!found) return reply.code(404).send({ error: "not found" });
    return found;
  });

  // Weblink "Create New Employee" staging (UC3 finalize)
  app.post("/api/v2/companies/:companyId/employees", async (req) => {
    const b = req.body as Body;
    const employeeId = `STG_${++stagedSeq}`;
    emp.push({
      employeeId,
      firstName: String(b.firstName ?? "Staged"), lastName: String(b.lastName ?? "Hire"),
      email: String(b.email ?? `${employeeId.toLowerCase()}@instantteams.test`),
      birthDate: String(b.birthDate ?? "1990-01-01"), hireDate: String(b.hireDate ?? "2022-01-01"),
      employeeType: "RFT", status: "A", costCenter: String(b.costCenter ?? "CC-OPS"),
      phone: String(b.phone ?? "+15555550100"), smsConsent: Boolean(b.smsConsent ?? false),
    });
    return { employeeId };
  });

  // ── Postmark ─────────────────────────────────────────────────────────────
  app.post("/email/withTemplate", async (req, reply) => {
    if (forceFailOnce) { forceFailOnce = false; return reply.code(500).send({ ErrorCode: 500, Message: "forced failure" }); }
    const b = req.body as Body;
    const alias = String(b.TemplateAlias ?? "");
    if (!EMAIL_ALIASES.has(alias)) return reply.code(422).send({ ErrorCode: 1101, Message: `template alias not found: ${alias}` });
    sent.push({ To: b.To, TemplateAlias: alias, Metadata: b.Metadata ?? {} });
    return { To: b.To, SubmittedAt: new Date().toISOString(), MessageID: `sim-${sent.length}`, ErrorCode: 0, Message: "OK" };
  });
  app.post("/_forceFail", async () => { forceFailOnce = true; return { ok: true }; });
  app.get("/_sent", async () => sent);

  // ── SMS ──────────────────────────────────────────────────────────────────
  app.post("/sms/send", async (req) => { const b = req.body as Body; sms.push(b); return { MessageID: `sms-${sms.length}` }; });
  app.get("/_sms", async () => sms);

  // ── Slack admin invite (idempotent by email) ─────────────────────────────
  app.post("/admin.users.invite", async (req) => {
    const email = String((req.body as Body).email ?? "");
    const already = invited.has(email);
    if (!already) invited.add(email);
    return { ok: true, already };
  });
  app.get("/_invites", async () => [...invited]);

  // ── Vetty screening + WorkBright submission file (rendered on demand from the employee store) ──
  app.get("/screening/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.type("application/pdf").send(Buffer.from(await renderDocument("background-check", docEmp(id, /^SCR-/))));
  });
  app.get("/api/submissions/:id/file", async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.type("application/pdf").send(Buffer.from(await renderDocument("I-9", docEmp(id, /^SUB-/))));
  });

  // ── Drive create (putFile) — drops into a "locked" folder; no re-permission route by design ──
  app.post("/files", async (req) => { const b = req.body as Body; files.push({ folderId: b.folderId, name: b.name }); return { fileId: `file-${files.length}` }; });
  app.get("/_files", async () => files);

  // ── Packet assign + EN send (the two RPA-runner writes; here they drop a receipt) ─────────────
  app.post("/packets/:employeeId/assign", async (req) => {
    const { employeeId } = req.params as { employeeId: string };
    const b = req.body as Body;
    const packetId = String(b.packetId ?? "");
    const docs = Array.isArray(b.docs) ? (b.docs as string[]) : [];
    assignments.push({ employeeId, packetId, docs });
    return { receiptId: `asg-${assignments.length}` };
  });
  app.get("/_assignments", async () => assignments);

  app.post("/en/:employeeId/send", async (req) => {
    const { employeeId } = req.params as { employeeId: string };
    ensends.push({ employeeId, doc: "benefits-summary.pdf" });
    return { receiptId: `en-${ensends.length}` };
  });
  app.get("/_ensends", async () => ensends);

  // ── Google Sheets (UC4 report sink) — SheetsReportSink makes two calls per report: a values:batchUpdate
  //    write, then (only when a row is highlighted) a companion call whose real Sheets API path appends
  //    ":batchUpdate" directly onto the spreadsheet id (no "/values" segment, no separating slash) — not a
  //    clean Fastify path param, so one wildcard route parses both shapes itself. ──
  app.post("/v4/spreadsheets/*", async (req, reply) => {
    const tail = (req.params as Body)["*"] as string;   // "<id>/values:batchUpdate" or "<id>:batchUpdate"
    const b = req.body as Body;
    if (tail.endsWith("/values:batchUpdate")) {
      const spreadsheetId = tail.slice(0, -"/values:batchUpdate".length);
      const data = (b.data as { values: unknown[][] }[] | undefined)?.[0];
      const rowCount = Math.max((data?.values.length ?? 1) - 1, 0);   // exclude the header row
      sheets.push({ spreadsheetId, rowCount, highlightedCount: 0 });
      return { spreadsheetId };
    }
    if (tail.endsWith(":batchUpdate")) {
      const spreadsheetId = tail.slice(0, -":batchUpdate".length);
      const requests = (b.requests as unknown[] | undefined) ?? [];
      const record = [...sheets].reverse().find((r) => r.spreadsheetId === spreadsheetId);
      if (record) record.highlightedCount = requests.length;
      return { spreadsheetId };
    }
    return reply.code(404).send({ error: `unknown Sheets route: ${tail}` });
  });
  app.get("/_sheets", async () => sheets);

  return app;
}

// `npm run simulator` — stand up a listening instance over the committed fixture (dev/demo only).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDemoEmployees } = await import("../src/synthdata/scenarios.js");
  const app = buildSimulator(loadDemoEmployees());
  const port = Number(new URL(process.env.SIMULATOR_URL ?? "http://127.0.0.1:8085").port || 8085);
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`simulator listening on :${port}`);
}
