/**
 * HTTP surface for the sync demo: REST API, Server-Sent Events, and the dashboard itself.
 * @lifespan PRODUCTION — the entry point. `npm run syncdemo`.
 * @responsibility Routing and transport only. No business logic; that is pipeline.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { bus } from "./bus.js";
import { loadConfig, publicConfig } from "./config.js";
import { closePool, migrate } from "./db.js";
import { Pipeline, ValidationError } from "./pipeline.js";
import { faults } from "./adapters/types.js";
import { slotMonitor } from "./slots.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "..", "ui");
const MOOLAI_CSS = join(HERE, "..", "..", "platform", "theme", "moolai.css");
const LOGOMARK = join(HERE, "..", "..", "platform", "theme", "logomark.svg");

export async function buildServer() {
  const cfg = loadConfig();
  await migrate(cfg.databaseUrl);

  const pipeline = new Pipeline(cfg);
  const app = Fastify({ logger: false });

  /**
   * Accept a POST with no body.
   *
   * /api/reset, /api/employees/:id/retry and /api/pipeline/poll are commands, not payloads —
   * there is nothing to send. A bare `fetch(url, { method: "POST" })` sets no Content-Type, and
   * Fastify rejects that with 415 Unsupported Media Type before the handler is ever reached, so
   * every one of those buttons would have been silently dead. This is a fallback parser: the
   * built-in application/json parser still takes precedence for requests that do have a body.
   */
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) return done(null, {});
    try { done(null, JSON.parse(text)); } catch { done(null, {}); }
  });

  // ── the dashboard ──────────────────────────────────────────────────────────────────────
  // Read from disk per request rather than cached: the file is a few KB and being able to edit
  // the dashboard and refresh, with no build step and no restart, is worth more than the read.
  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFileSync(join(UI_DIR, "index.html"), "utf8");
  });


  // The brand tokens, shared with the approval app on :5173. Served from src/platform/theme so
  // there is one file both dashboards and that app agree on.
  app.get("/moolai.css", async (_req, reply) => {
    reply.type("text/css; charset=utf-8");
    return readFileSync(MOOLAI_CSS, "utf8");
  });


  // The real logomark from the design system, rather than a CSS gradient approximation.
  app.get("/logomark.svg", async (_req, reply) => {
    reply.type("image/svg+xml; charset=utf-8");
    return readFileSync(LOGOMARK, "utf8");
  });

  app.get("/app.css", async (_req, reply) => {
    reply.type("text/css; charset=utf-8");
    return readFileSync(join(UI_DIR, "app.css"), "utf8");
  });

  app.get("/app.js", async (_req, reply) => {
    reply.type("text/javascript; charset=utf-8");
    return readFileSync(join(UI_DIR, "app.js"), "utf8");
  });

  // ── Server-Sent Events ─────────────────────────────────────────────────────────────────
  app.get("/api/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this, a proxy that buffers will hold every event until the response ends —
      // which for a stream is never, so the dashboard would simply look broken.
      "X-Accel-Buffering": "no",
    });

    const send = (data: unknown) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send({ type: "hello", config: publicConfig(cfg) });

    const unsubscribe = bus.subscribe(send);
    // Comment frames keep the connection alive through proxies with idle timeouts and give the
    // browser something to notice if the server disappears.
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": keepalive\n\n");
    }, 15_000);

    req.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    // Returning would end the response; a stream must stay open.
    await new Promise(() => { /* until the client disconnects */ });
  });

  // ── state ──────────────────────────────────────────────────────────────────────────────
  app.get("/api/snapshot", async () => pipeline.snapshot());

  app.get("/api/config", async () => publicConfig(cfg));

  // The slot pool on its own, for anyone scripting against it or checking capacity before
  // a demo without pulling the whole snapshot.
  app.get("/api/slots", async () => slotMonitor());

  // ── the demo action ────────────────────────────────────────────────────────────────────
  app.post("/api/employees", async (req, reply) => {
    try {
      const result = await pipeline.createEmployee(req.body as Record<string, string>);
      // 202, not 201: the source system has the employee, but the synchronisation the caller
      // cares about has not finished and deliberately is not awaited here.
      return reply.code(202).send({ ...result, message: "created in the source system; pipeline will pick it up" });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/employees/:id/retry", async (req, reply) => {
    const out = await pipeline.retry(req.params.id);
    return reply.code(out.ok ? 200 : 502).send(out);
  });

  // ── operating the demo ─────────────────────────────────────────────────────────────────
  app.post("/api/faults", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<typeof faults>;
    for (const key of ["postgresDown", "workdayFail", "striimStall"] as const) {
      if (typeof body[key] === "boolean") faults[key] = body[key];
    }
    bus.publish({ type: "systems" });
    return reply.send({ faults });
  });

  app.post("/api/pipeline/poll", async () => {
    await pipeline.integration.pollNow();
    return { ok: true };
  });

  // Force the integration layer to re-read the source. In live mode this restarts the real Striim
  // application, which takes ~12s, so the route is deliberately slow rather than fire-and-forget:
  // the dashboard button needs to know whether it worked.
  app.post("/api/pipeline/force-read", async (_req, reply) => {
    const out = await pipeline.integration.forceRead();
    return reply.code(out.ok ? 200 : 502).send(out);
  });

  app.post("/api/pipeline/:action", async (req, reply) => {
    const { action } = req.params as { action: string };
    if (action === "start") { await pipeline.start(); return { ok: true, state: "started" }; }
    if (action === "stop") { await pipeline.stop(); return { ok: true, state: "stopped" }; }
    return reply.code(400).send({ error: `unknown action ${action}` });
  });

  app.post("/api/reset", async () => { await pipeline.reset(); return { ok: true }; });

  app.get("/api/health", async () => {
    const s = await pipeline.snapshot();
    return {
      ok: s.systems.postgres.health.ok,
      systems: Object.fromEntries(Object.entries(s.systems).map(([k, v]) => [k, { mode: v.mode, ok: v.health.ok }])),
    };
  });

  return { app, cfg, pipeline };
}

/**
 * Only run when executed directly, so tests can import buildServer without binding a port.
 *
 * pathToFileURL rather than string-building the URL: on Windows a drive path yields
 * file:///C:/... with THREE slashes, and `file://` + the path gives two, so the naive comparison
 * silently never matches and the process exits 0 having started nothing.
 */
const entry = process.argv[1];
const isMain = Boolean(entry) && import.meta.url === pathToFileURL(entry as string).href;
if (isMain || process.env.SYNCDEMO_FORCE_START === "1") {
  const { app, cfg, pipeline } = await buildServer();
  await pipeline.start();
  await app.listen({ port: cfg.port, host: "0.0.0.0" });

  const pub = publicConfig(cfg);
  const line = (label: string, v: { mode: string; target?: string; reason?: string }) =>
    `    ${label.padEnd(11)} ${v.mode.toUpperCase().padEnd(5)} ${v.target ?? ""}${v.reason ? `  (${v.reason})` : ""}`;
  console.log(`\n  Employee sync demo on http://localhost:${cfg.port}\n`);
  console.log(line("BambooHR", pub.systems.bamboohr));
  console.log(line("Striim", pub.systems.striim));
  console.log(line("PostgreSQL", pub.systems.postgres));
  console.log(line("Workday", pub.systems.workday));
  console.log(`\n  Set SYNCDEMO_MODE=live to use the real systems (writes to real BambooHR and Workday).\n`);

  const shutdown = async () => {
    await pipeline.stop();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
