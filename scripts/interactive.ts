/** @lifespan THROWAWAY — the INTERACTIVE client demo: pick any employee, a settable clock to simulate the 60-day
 * wait, real Outlook/Graph email sent natively (no external service), and live human approvals.
 *
 * Clock: createTimeSkipping() + workflows started via `.start()` (never awaited) = the server stays in NORMAL mode,
 * so parked approvals do NOT auto-expire. Time only moves when POST /clock/advance calls env.sleep(). No Docker/PG.
 * Email: sendEmail + (SMS→)sendSms are routed through the native Graph mail component when GRAPH_TENANT_ID
 * (+ CLIENT_ID/CLIENT_SECRET/SENDER_EMAIL) are set; else in-memory. */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { buildSimulator } from "../simulator/saasSimulator.js";
import { loadDemoEmployees, makeEmployee, employeeStartingOn } from "../src/synthdata/scenarios.js";
import { loadEnv } from "../src/platform/config/env.js";
import { MODULES } from "../src/platform/registry.js";
import { mergeActivities, workflowsBundlePath } from "../src/platform/worker.js";
import { buildIngress } from "../src/platform/ingress.js";
import { buildConnectorRegistry } from "../src/platform/connectors/registry.js";
import { buildApprovalServer } from "../src/platform/approval-api/approvalServer.js";
import { GraphEmailConnector } from "../src/platform/connectors/comms/graphEmailConnector.js";
import type { MailAttachment } from "../src/platform/connectors/comms/graphMail.js";
import { renderDocument, type DocKind } from "../simulator/documentGenerator.js";
import type { PendingApproval, TransactionalEmail, SmsMessage, EmployeeRecord, PacketRecommendation, FinanceReportRow } from "../src/platform/domain/types.js";
import { upsertPending, setStatus, getApproval, listPending } from "../src/platform/db/approvals.js";
import { alreadySent, recordSend, migrate } from "../src/platform/db/sendLedger.js";
import { listEmployees } from "../src/platform/db/employees.js";
import { getPool } from "../src/platform/db/pool.js";
import { MigrationService } from "../src/platform/migration/service.js";
import { CutoverRefused } from "../src/platform/migration/cutover.js";

const API_PORT = 8090;

// The migration panel is OPTIONAL. With no TARGET_DATABASE_URL the endpoints answer
// "not configured" and the rest of the demo is untouched — `npm run interactive` still
// needs neither Docker nor Postgres, which is a promise the README makes.
const migration = process.env.TARGET_DATABASE_URL ? new MigrationService() : null;
const DAY = 864e5;
const FIXTURE = loadDemoEmployees();

/** In pg mode the employees TABLE is what the demo reads — it is the bulk load Striim
 *  copies, and reading it is what makes the row counts on the panel mean something. The
 *  committed fixture stays the source of truth for the offline test tiers. */
let roster: EmployeeRecord[] = FIXTURE;
async function refreshRoster(): Promise<void> {
  if (LEDGER_MODE !== "pg") return;
  const rows = await listEmployees();
  if (rows.length) roster = rows;
  else console.warn("[ledger] employees table is empty — run: npx tsx scripts/load-employees.ts");
}

const DEMO_EMAIL_TO = process.env.DEMO_EMAIL_TO ?? "sarahm@moolai.ai";
const emailer = process.env.GRAPH_TENANT_ID
  ? new GraphEmailConnector({
      tenantId: process.env.GRAPH_TENANT_ID,
      clientId: process.env.GRAPH_CLIENT_ID ?? "",
      clientSecret: process.env.GRAPH_CLIENT_SECRET ?? "",
      senderEmail: process.env.SENDER_EMAIL ?? "",
      fromDisplayName: process.env.FROM_DISPLAY_NAME,
      replyToEmail: process.env.REPLY_TO_EMAIL,
      redirectTo: DEMO_EMAIL_TO,
    })
  : null;

// ── LEDGER_MODE: where approvals and the send ledger actually live ──────────
//
// memory (the default) keeps them in this process, which is what lets `npm run interactive`
// need neither Docker nor Postgres. pg sends them to the database the migration MOVES —
// without it the panel's send_ledger and pending_approvals counts stay at zero while you
// drive the arc, and the idempotency proof has nothing to read.
const LEDGER_MODE: "memory" | "pg" = process.env.LEDGER_MODE === "pg" ? "pg" : "memory";

/** One shape over both backings, so every call site below reads the same either way. */
interface Inbox {
  put(p: PendingApproval): Promise<void>;
  get(id: string): Promise<PendingApproval | undefined>;
  mark(id: string, status: PendingApproval["status"]): Promise<void>;
  pending(): Promise<PendingApproval[]>;
  /** Everything the journey needs, fetched once — approvalStep() below is synchronous. */
  snapshot(ids: string[]): Promise<Map<string, PendingApproval>>;
  forget(id: string): Promise<void>;
  startRun(): Promise<void>;
}

const memoryMap = new Map<string, PendingApproval>();

const memoryInbox: Inbox = {
  put: async (p) => { memoryMap.set(p.id, p); },
  get: async (id) => memoryMap.get(id),
  mark: async (id, status) => { const p = memoryMap.get(id); if (p) memoryMap.set(id, { ...p, status }); },
  pending: async () => [...memoryMap.values()].filter((p) => p.status === "pending"),
  snapshot: async (ids) => new Map(ids.flatMap((id) => { const p = memoryMap.get(id); return p ? [[id, p] as const] : []; })),
  forget: async (id) => { memoryMap.delete(id); },
  startRun: async () => { memoryMap.clear(); },
};

const pgInbox: Inbox = {
  put: (p) => upsertPending(p),
  get: (id) => getApproval(id),
  mark: (id, status) => setStatus(id, status),
  pending: () => listPending(),
  snapshot: async (ids) => {
    const found = await Promise.all(ids.map(async (id) => [id, await getApproval(id)] as const));
    return new Map(found.flatMap(([id, p]) => (p ? [[id, p] as const] : [])));
  },
  // A row in the ledger is not a thing you throw away — it is the record the migration is
  // moving. Expiring it keeps the reviewer's inbox clean AND keeps the history intact.
  forget: (id) => setStatus(id, "expired"),
  startRun: async () => {
    for (const p of await listPending()) await setStatus(p.id, "expired");
  },
};

const inbox: Inbox = LEDGER_MODE === "pg" ? pgInbox : memoryInbox;
const activity: { kind: "email" | "sms"; template?: string; to?: string; at: string; skipped?: boolean }[] = [];
// Demo-only: the actual UC4 report rows, kept so /reports/:name can render a viewable table (prod writes a real Sheet).
const financeReports = new Map<string, FinanceReportRow[]>();
// Clock guards. Time-skipping deadlocks if a fast-forward (a) STOPS while a workflow is parked on wf.condition()
// — i.e. a pending approval — or (b) runs after an abandoned child that took an Update (the Day-60 benefits child).
// Two rules make both unreachable: never advance while any approval is pending (approve it first, so the skip only
// crosses durable timers), and never advance past Day 60 — the last TIME-based milestone (Day-60 email + benefits
// hand-off); everything after is human-gated, not time-gated. Day 60 is derived from the run's startMs.
const LAST_MILESTONE_DAY = 60;
interface Run { runId: string; realId: string; firstName: string; name: string; email: string; startMs: number; emp: EmployeeRecord; }
let currentRun: Run | null = null;
let runSeq = 0;

// Demo-only: attach the pdfkit-generated onboarding docs to the matching email (welcome → I-9 + background-check;
// Day-60 → benefits-summary; onboarding-packet → one PDF per reviewer-chosen doc). Doc generation stays in the
// throwaway simulator layer — prod fetches real vendor docs.
const DOCS_FOR_EMAIL: Record<string, { kind: DocKind; filename: string }[]> = {
  welcome: [{ kind: "I-9", filename: "I-9.pdf" }, { kind: "background-check", filename: "background-check.pdf" }],
  "day60-compliance": [{ kind: "benefits-summary", filename: "benefits-summary.pdf" }],
};
async function docAttachmentsFor(alias: string, emp: EmployeeRecord, model: Record<string, string>): Promise<MailAttachment[]> {
  if (alias === "onboarding-packet") {                                     // attach a PDF per chosen doc (from the decision)
    const docs = (model.docs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return Promise.all(docs.map(async (d) => ({
      filename: `${d}.pdf`, contentType: "application/pdf", content: await renderDocument(d, emp),
    })));
  }
  return Promise.all((DOCS_FOR_EMAIL[alias] ?? []).map(async (d) => ({
    filename: d.filename, contentType: "application/pdf", content: await renderDocument(d.kind, emp),
  })));
}

async function buildJourney() {
  const day = currentRun ? Math.max(0, Math.round(((await env.currentTimeMs()) - currentRun.startMs) / DAY)) : 0;
  if (!currentRun) return { employee: null, clock: { day: 0 }, steps: [] };
  const emailSent = (t: string) => activity.some((a) => a.kind === "email" && a.template === t);
  const smsSent = activity.some((a) => a.kind === "sms");
  const ids = [`packet:${currentRun.runId}`, `benefits:${currentRun.runId}`];
  const seen = await inbox.snapshot(ids);          // one fetch; approvalStep stays sync
  const approvalStep = (id: string, label: string) => {
    const a = seen.get(id);
    const rec = a?.detail as PacketRecommendation | { doc?: string } | undefined;
    const summary = a?.kind === "packet-assignment" && rec && "packetId" in rec
      ? `${rec.packetId} · ${Math.round((rec.confidence ?? 0) * 100)}%`
      : a?.kind === "benefits-send" && rec && "doc" in rec ? String(rec.doc) : undefined;
    return { key: id, label, kind: "approval" as const, status: a?.status ?? "waiting", summary, approval: a };
  };
  return {
    employee: { id: currentRun.realId, name: currentRun.name },
    clock: { day },
    steps: [
      { key: "welcome-email", label: "Welcome email", kind: "auto" as const, status: emailSent("welcome") ? "done" : "waiting", note: "onboarding kickoff" },
      { key: "welcome-sms", label: "Welcome SMS (as email)", kind: "auto" as const, status: smsSent ? "done" : "waiting", note: "delivered as email (SMS stand-in)" },
      { key: "day60", label: "Day-60 compliance notice", kind: "auto" as const, status: emailSent("day60-compliance") ? "done" : "scheduled", note: "advance the clock to Day 60 to send" },
      approvalStep(`packet:${currentRun.runId}`, "Onboarding packet"),
      approvalStep(`benefits:${currentRun.runId}`, "Benefits Day-60 send"),
    ],
  };
}

// Recreated per employee (see freshEnv). `let` so the demo endpoints, which close over `env`, always see the current one.
let env = await TestWorkflowEnvironment.createTimeSkipping();

async function main() {
  if (LEDGER_MODE === "pg") {
    // schema.sql is idempotent, and re-applying it also re-asserts REPLICA IDENTITY FULL —
    // without which Striim replicates INSERTs and silently drops every UPDATE.
    await migrate();
    await refreshRoster();
    console.log(`[ledger] pg mode — approvals and the send ledger are in Postgres (${roster.length} employees)`);
  }
  const simPort = Number(new URL(loadEnv().simulatorUrl).port || 8085);
  let sim = buildSimulator([]);                                   // rebuilt with the chosen employee on each /run
  await sim.listen({ port: simPort, host: "127.0.0.1" });

  // Worker: real simulator-backed activities (getEmployee/recommendPacket/assignPacket/stageSend); DB-backed ones
  // swapped for in-memory; sendEmail + sendSms routed to real Graph email (or in-memory when no connector).
  const activities = {
    ...mergeActivities(MODULES),
    sendEmail: async (e: TransactionalEmail) => {
      // THE IDEMPOTENCY GATE. In pg mode this reads the send ledger BEFORE sending and
      // records the send after — the same two calls the production activity makes. It is
      // what makes the post-cutover proof possible: after the flip, alreadySent() reads
      // the NEW database, finds the key the OLD one recorded, and skips. If the ledger had
      // migrated unfaithfully, a real person would get a second copy of this email.
      if (LEDGER_MODE === "pg" && await alreadySent(e.idempotencyKey)) {
        console.log(`[email] SKIPPED (already in the ledger): ${e.templateAlias} -> ${e.to}`);
        activity.push({ kind: "email", template: e.templateAlias, to: e.to, at: new Date().toISOString(), skipped: true });
        return { skipped: true as const };
      }
      activity.push({ kind: "email", template: e.templateAlias, to: e.to, at: new Date().toISOString() });
      if (emailer) {                                                        // hire-arc AND scan emails (scans have no currentRun)
        const toName = [e.model?.firstName, e.model?.lastName].filter(Boolean).join(" ") || currentRun?.name || e.to;
        const attachments = currentRun ? await docAttachmentsFor(e.templateAlias, currentRun.emp, e.model) : [];
        console.log(`[email] ${e.templateAlias} → ${e.to} · ${attachments.length} attachment(s)`);
        await emailer.send(e.to, toName, e.templateAlias, e.model, attachments).catch((err: Error) => console.error("[email] failed:", err.message));
      }
      const messageId = `mem-${activity.length}`;
      if (LEDGER_MODE === "pg") {
        await recordSend({ idempotencyKey: e.idempotencyKey, to: e.to, template: e.templateAlias, status: "sent", messageId });
      }
      return { messageId };
    },
    sendSms: async (_m: SmsMessage) => {                          // SMS step, delivered as email in the demo
      activity.push({ kind: "sms", at: new Date().toISOString() });
      if (emailer && currentRun) await emailer.send(currentRun.email, currentRun.name, "welcome-sms", { firstName: currentRun.firstName }).catch((err: Error) => console.error("[sms→email] failed:", err.message));
      return { messageId: `sms-${activity.length}` };
    },
    registerPending: async (p: PendingApproval) => { await inbox.put(p); },
    resolvePending: async (id: string, status: PendingApproval["status"]) => { await inbox.mark(id, status); },
    alarmDidNotSend: async () => {},
    // UC4: in prod SheetsReportSink writes a real Google Sheet; the demo keeps the rows and returns a LOCAL viewable
    // URL so the report opens in-browser (no external Sheets access needed). Overriding here mirrors sendEmail above.
    writeFinanceReport: async (name: string, rows: FinanceReportRow[]) => {
      financeReports.set(name, rows);
      return { location: `http://127.0.0.1:${API_PORT}/reports/${encodeURIComponent(name)}` };
    },
  };
  let worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "main", workflowsPath: workflowsBundlePath(), activities });
  let run = worker.run();
  let ingress = buildIngress(MODULES, { temporal: env.client, connectors: buildConnectorRegistry() }, { verifyPaylocityAuth: () => true });

  // A finished abandoned child (the Day-60 benefits send, which took an approval Update) stays in the test server's
  // history and jams every later env.sleep — and a finished workflow can't be terminated, nor a Temporal clock
  // rewound. So each employee gets a clean Temporal world: tear the env down and recreate it (~0.7s). Invisible —
  // "Day" is measured from selection, so the new hire still starts at Day 0.
  async function freshEnv(): Promise<void> {
    worker.shutdown(); await run.catch(() => {}); await env.teardown();
    env = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "main", workflowsPath: workflowsBundlePath(), activities });
    run = worker.run();
    ingress = buildIngress(MODULES, { temporal: env.client, connectors: buildConnectorRegistry() }, { verifyPaylocityAuth: () => true });
  }

  async function runEmployee(realId: string) {
    const rec = roster.find((e) => e.employeeId === realId);
    if (!rec) throw new Error(`unknown employee ${realId}`);
    await freshEnv();                                                       // clean Temporal world for this employee
    const startMs = await env.currentTimeMs();
    const runId = `${realId}-r${++runSeq}`;
    const hireDate = new Date(startMs).toISOString().slice(0, 10);          // Day-0 anchored to the demo clock
    const runEmp: EmployeeRecord = { ...rec, employeeId: runId, smsConsent: true, hireDate };
    await inbox.startRun(); activity.length = 0;
    await sim.close(); sim = buildSimulator([runEmp]); await sim.listen({ port: simPort, host: "127.0.0.1" });
    currentRun = { runId, realId, firstName: rec.firstName, name: `${rec.firstName} ${rec.lastName}`, email: rec.email, startMs, emp: runEmp };
    await ingress.inject({ method: "POST", url: "/webhooks/paylocity", payload: { companyId: "C1", employeeId: runId } });
    await new Promise((r) => setTimeout(r, 400));                            // let welcome/SMS + packet-recommend settle
  }

  // ── Approval API + demo endpoints (CORS for the Vite origin) ──────────────
  const api = buildApprovalServer({
    listPending: () => inbox.pending(),
    getApproval: (id) => inbox.get(id),
    getHandle: (id) => env.client.workflow.getHandle(id),
  });
  api.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") await reply.code(204).send();
  });
  // Demo-only: render a captured UC4 finance report as a viewable HTML table (transitions highlighted). In prod
  // this is a real Google Sheet; here writeFinanceReport (above) points `location` at this route.
  api.get("/reports/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const rows = financeReports.get(name);
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
    if (!rows) return reply.code(404).type("text/html").send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h1>Report not found</h1><p>No finance report named “${esc(name)}”. Run the daily scans first.</p></body>`);
    const transitions = rows.filter((r) => r.isTransition).length;
    const body = rows.map((r) => `<tr${r.isTransition ? ' style="background:#FFF3B0"' : ""}><td>${esc(r.employeeId)}</td><td>${esc(r.name)}</td><td>${esc(r.costCenter)}</td><td>${esc(r.priorCostCenter ?? "")}</td><td>${esc(r.hireDate)}</td><td>${r.isTransition ? "⚠️ transition" : ""}</td></tr>`).join("");
    return reply.type("text/html").send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title>
<style>body{font-family:system-ui,sans-serif;color:#212121;background:#F5F2ED;margin:0;padding:40px}
h1{font-weight:400;margin:0 0 4px}.sub{color:#555;margin:0 0 24px}
table{border-collapse:collapse;width:100%;max-width:900px;background:#FAF8F5;border:1px solid #D0C3BF;border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #E7DED6;font-size:14px}
th{background:#212121;color:#F5F2ED;font-weight:500;letter-spacing:.04em}
caption{caption-side:bottom;color:#777;font-size:12px;padding-top:10px;text-align:left}</style></head>
<body><h1>${esc(name)}</h1><p class="sub">${rows.length} new hire(s) this month · ${transitions} cost-center transition(s) highlighted</p>
<table><caption>Highlighted rows changed cost center vs. their prior assignment. This is the demo stand-in for the Google Sheet finance receives.</caption>
<thead><tr><th>Employee ID</th><th>Name</th><th>Cost center</th><th>Prior cost center</th><th>Hire date</th><th>Flag</th></tr></thead>
<tbody>${body}</tbody></table></body></html>`);
  });

  api.get("/journey", async () => buildJourney());
  api.get("/employees", async () => {
    // Re-read the table on every list in pg mode, so an employee added with
    // scripts/load-employees.ts shows up on a browser refresh rather than needing a
    // restart. It is one small query against a 200-row table.
    await refreshRoster();
    return roster.map((e) => ({ id: e.employeeId, name: `${e.firstName} ${e.lastName}`, employeeType: e.employeeType, costCenter: e.costCenter }));
  });
  api.post("/run", async (req) => { await runEmployee((req.body as { employeeId: string }).employeeId); return buildJourney(); });
  api.post("/clock/advance", async (req) => {
    const days = Math.max(1, Math.round((req.body as { days: number }).days));
    // Don't skip while an approval is pending (a wf.condition() park) — decide it first; the UI surfaces this.
    if ((await inbox.pending()).length > 0) return { ...(await buildJourney()), blocked: "approval-pending" };
    const now = await env.currentTimeMs();
    let targetMs = now + days * DAY;
    if (currentRun) targetMs = Math.min(targetMs, currentRun.startMs + LAST_MILESTONE_DAY * DAY);   // never past Day 60
    const deltaMs = targetMs - now;
    if (deltaMs > 0) await env.sleep(deltaMs);
    await new Promise((r) => setTimeout(r, 600));                            // let matured timers (Day-60 → benefits) settle
    return buildJourney();
  });
  // ── Demo-only: run the three recurring scans (UC5 birthday/anniversary, UC8 starts-tomorrow, UC4 monthly
  //    finance) over a seeded population so each produces visible output. In prod these are `schedule`-triggered;
  //    the interactive demo is event-driven, so this endpoint is the explicit trigger. Seeds guaranteed actors
  //    (birthday-today, anniversary-today, starts-tomorrow, a this-month cost-center transfer) alongside the
  //    fixture + any active hire, so the scans always show something. ──
  api.post("/scans/run", async () => {
    const scanToday = new Date().toISOString().slice(0, 10);
    const scanMonth = scanToday.slice(0, 7);
    const mmdd = scanToday.slice(5);
    const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    const scanPop: EmployeeRecord[] = [
      ...roster,
      ...(currentRun ? [currentRun.emp] : []),                              // keep an active hire resolvable
      makeEmployee({ employeeId: "EMP-BDAY", firstName: "Bea", lastName: "Day", email: "bea.day@instantteams.test", birthDate: `1990-${mmdd}`, hireDate: "2022-01-01" }),
      makeEmployee({ employeeId: "EMP-ANNIV", firstName: "Otto", lastName: "Mark", email: "otto.mark@instantteams.test", birthDate: "1988-01-15", hireDate: `2021-${mmdd}` }),
      { ...employeeStartingOn(tomorrow), firstName: "Sam", lastName: "Newton", email: "sam.newton@instantteams.test" },
      makeEmployee({ employeeId: "EMP-XFER", firstName: "Cam", lastName: "Cruz", email: "cam.cruz@instantteams.test", hireDate: `${scanMonth}-05`, costCenter: "CC-CX", priorCostCenter: "CC-OPS" }),
    ];
    await sim.close(); sim = buildSimulator(scanPop); await sim.listen({ port: simPort, host: "127.0.0.1" });
    const before = activity.length;
    const seq = ++runSeq;
    const uc4Id = `uc4:${scanMonth}:r${seq}`;
    await env.client.workflow.start("birthdayAnniversaryScan", { taskQueue: "main", workflowId: `uc5:${scanToday}:r${seq}`, args: [{ companyId: "C1", todayISO: scanToday }] });
    await env.client.workflow.start("startingSoonScan", { taskQueue: "main", workflowId: `uc8:${scanToday}:r${seq}`, args: [{ companyId: "C1", todayISO: scanToday }] });
    await env.client.workflow.start("monthlyFinanceReport", { taskQueue: "main", workflowId: uc4Id, args: [{ companyId: "C1", monthISO: scanMonth }] });
    // Wait until UC4 has listed → written → emailed Finance → parked on its approval (the approval landing in the
    // inbox is that signal), so we capture the full output before tearing it down. Up to ~6s covers a slow live-Graph
    // send; the birthday/starts-soon scans (lighter, no park) have finished well before then.
    for (let i = 0; i < 60 && !(await inbox.get(uc4Id)); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 150));                           // let UC5/UC8 emails + invites flush
    const newEmails = activity.slice(before).filter((a) => a.kind === "email");
    const slackInvites = (await (await fetch(`${loadEnv().simulatorUrl}/_invites`)).json()) as string[];
    const fin = await inbox.get(uc4Id);
    const financeReport = fin ? { ...(fin.detail as Record<string, unknown>), approvalId: fin.id } : null;
    // The scans share the hire arc's ONE time-skipping env + inbox. UC4 parks on awaitApproval (a wf.condition),
    // which would both wedge the clock guard (any pending → block) and deadlock a later env.sleep. The demo only
    // needs the OUTPUT captured above, not the human release ack — so terminate UC4 and drop its approval, leaving
    // the hire-arc clock free. The report stays viewable via /reports/:name; UC5/UC8 completed and leave nothing parked.
    await env.client.workflow.getHandle(uc4Id).terminate("demo: finance-report output captured").catch(() => {});
    await inbox.forget(uc4Id);
    return {
      scanToday, scanMonth,
      birthdays: newEmails.filter((a) => a.template === "birthday").map((a) => a.to),
      anniversaries: newEmails.filter((a) => a.template === "anniversary").map((a) => a.to),
      slackInvites,
      financeReport,
    };
  });

  // ── Migration endpoints (Striim CDC source -> target) ─────────────────────
  // Every one is a POST behind a button. Nothing is on a timer except GET /migration/status,
  // which the panel polls for display.
  const notConfigured = { configured: false as const,
    reason: "TARGET_DATABASE_URL is not set, so there is nowhere to migrate to." };

  // Which HRIS is actually feeding this platform, and is it live?
  //
  // The stack picker on the gate screen is cosmetic — it lets you choose "Paylocity" while
  // the real feed is BambooHR. That is fine for a configurator and misleading anywhere else,
  // so this endpoint reports the TRUTH: which system the employees in the database came
  // from, how many there are, and how recently anything arrived.
  api.get("/hris/status", async () => {
    const source = process.env.BAMBOOHR_DOMAIN?.trim()
      ? { id: "bamboohr", label: "BambooHR", detail: process.env.BAMBOOHR_DOMAIN.trim() }
      : { id: "simulator", label: "Paylocity (simulated)", detail: "no live HRIS configured" };

    // The flow has TWO ends and the UI should say so: BambooHR in, Workday out. Reporting
    // only the source made it look like a one-way feed, which is not what this is.
    // "ready" means credentials are present and the OAuth chain is usable — NOT that a write
    // has happened. Nothing is written until someone runs push:adaptive with --live.
    const destination = process.env.ADAPTIVE_REFRESH_TOKEN?.trim()
      ? {
          id: "workday-adaptive",
          label: "Workday Adaptive Planning",
          detail: process.env.ADAPTIVE_INSTANCE_CODE?.trim() ?? "configured",
          ready: true,
          mode: "dry-run until push:adaptive --live",
        }
      : { id: "none", label: "no destination configured", detail: "", ready: false, mode: "" };

    if (LEDGER_MODE !== "pg") {
      return { ...source, connected: false, reason: "LEDGER_MODE is memory — nothing is read from Postgres",
               employees: 0, landingRows: 0, lastSyncedAt: null, destination };
    }
    try {
      const pool = getPool();
      // employee_id is numeric only for rows that came from BambooHR; the committed fixture
      // uses EMP_* ids. That is how we tell a live feed from seed data.
      const live = await pool.query<{ n: string; last: string | null }>(
        `SELECT count(*) AS n, max(updated_at)::text AS last
           FROM employees WHERE employee_id ~ '^[0-9]+$'`);
      let landing = 0;
      try {
        const l = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM bamboohr_employees`);
        landing = Number(l.rows[0]?.n ?? 0);
      } catch { /* the Striim reader creates this table; absent until the first load */ }
      return {
        ...source,
        connected: Number(live.rows[0]?.n ?? 0) > 0,
        employees: Number(live.rows[0]?.n ?? 0),
        landingRows: landing,
        lastSyncedAt: live.rows[0]?.last ?? null,
        destination,
      };
    } catch (e) {
      return { ...source, connected: false, reason: (e as Error).message.slice(0, 120),
               employees: 0, landingRows: 0, lastSyncedAt: null, destination };
    }
  });

  api.get("/migration/status", async () => {
    if (!migration) return notConfigured;
    return { configured: true, ...(await migration.status()) };
  });

  api.post("/migration/cdc/start", async (_req, reply) => {
    if (!migration) return reply.code(409).send(notConfigured);
    try {
      const slot = await migration.startCdc();
      return { ok: true, slot };
    } catch (e) { return reply.code(409).send({ ok: false, reason: (e as Error).message }); }
  });

  api.post("/migration/initial-load", async (_req, reply) => {
    if (!migration) return reply.code(409).send(notConfigured);
    try {
      await migration.startInitialLoad();
      return { ok: true };
    } catch (e) {
      // A refusal is a 409 with a reason, never a 500. The operator is being told why the
      // button did not do anything, which is the whole point of refusing.
      const refused = e instanceof CutoverRefused;
      return reply.code(refused ? 409 : 500).send({ ok: false, reason: (e as Error).message });
    }
  });

  api.post("/migration/reconcile", async (_req, reply) => {
    if (!migration) return reply.code(409).send(notConfigured);
    return { ok: true, tables: await migration.reconcileNow() };
  });

  api.post("/migration/cutover", async (_req, reply) => {
    if (!migration) return reply.code(409).send(notConfigured);
    try {
      return { ok: true, steps: await migration.cutoverNow() };
    } catch (e) {
      const refused = e instanceof CutoverRefused;
      return reply.code(refused ? 409 : 500).send({
        ok: false, refusedAt: refused ? (e as CutoverRefused).step : null,
        reason: (e as Error).message,
      });
    }
  });

  // THE PROOF. Replays a send that the OLD database already recorded, through the real
  // production activity, against whichever database the app is pointed at NOW. After the
  // cutover that is the target — so a `skipped: true` here is the idempotency gate reading
  // the new database, finding the key the old one wrote, and declining to send again.
  //
  // Counts and checksums are a DBA's evidence. Not emailing a real person twice is the
  // business's evidence, and it is the same assertion the platform makes every day.
  api.post("/migration/proof", async (req, reply) => {
    if (LEDGER_MODE !== "pg") {
      return reply.code(409).send({ ok: false, reason: "LEDGER_MODE=pg is required — in memory mode there is no ledger to read." });
    }
    const asked = (req.body as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    const latest = await getPool().query<{ k: string; to: string; t: string }>(
      `SELECT idempotency_key AS k, "to", template AS t FROM send_ledger
        WHERE status = 'sent' ORDER BY id DESC LIMIT 1`);
    const key = asked ?? latest.rows[0]?.k;
    if (!key) return reply.code(409).send({ ok: false, reason: "the ledger holds no sent rows yet — run an onboarding arc first" });

    const before = await getPool().query<{ n: string }>(`SELECT count(*)::bigint AS n FROM send_ledger`);
    const replay = await activities.sendEmail({
      to: latest.rows[0]?.to ?? "replay@instantteams.test",
      templateAlias: (latest.rows[0]?.t ?? "welcome") as TransactionalEmail["templateAlias"],
      model: {}, idempotencyKey: key,
    });
    const after = await getPool().query<{ n: string }>(`SELECT count(*)::bigint AS n FROM send_ledger`);
    const url = new URL(loadEnv().ledgerDatabaseUrl);
    return {
      ok: true,
      readingDatabase: `${url.host}${url.pathname}`,
      idempotencyKey: key,
      skipped: "skipped" in replay && replay.skipped === true,
      ledgerRowsBefore: Number(before.rows[0]?.n ?? 0),
      ledgerRowsAfter: Number(after.rows[0]?.n ?? 0),
    };
  });

  api.post("/migration/reset", async (_req, reply) => {
    if (!migration) return reply.code(409).send(notConfigured);
    return { ok: true, ...(await migration.reset()) };
  });

  await api.listen({ port: API_PORT, host: "127.0.0.1" });

  console.log(`\n  ✅ Interactive demo UP.  API http://127.0.0.1:${API_PORT}`);
  console.log(`     Email: ${emailer ? `LIVE via Graph (${process.env.SENDER_EMAIL}) → all mail to ${DEMO_EMAIL_TO}` : "OFFLINE (set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET/SENDER_EMAIL to send real mail)"}`);
  console.log(`     UI:    VITE_APPROVAL_API=http://127.0.0.1:${API_PORT} npm run ui:dev  → open the printed URL\n`);

  const shutdown = async () => { worker.shutdown(); await run.catch(() => {}); await api.close(); await sim.close(); await env.teardown(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
