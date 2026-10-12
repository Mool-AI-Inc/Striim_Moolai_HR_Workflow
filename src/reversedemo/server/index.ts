/**
 * HTTP surface for the reverse pipeline. Port 3001 by default.
 * @lifespan PRODUCTION — the entry point. `npm run reversedemo`.
 *
 * A separate process from the forward pipeline on purpose: the two are each other's fallback, so
 * a crash, a bad deploy or an exhausted upstream in one must leave the other serving.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { bus } from "./bus.js";
import { loadReverseConfig, publicReverseConfig } from "./config.js";
import { closePool, migrate } from "./db.js";
import { ReversePipeline, StageFailure } from "./pipeline.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "..", "ui");
const MOOLAI_CSS = join(HERE, "..", "..", "platform", "theme", "moolai.css");
const LOGOMARK = join(HERE, "..", "..", "platform", "theme", "logomark.svg");

export async function buildReverseServer() {
  const cfg = loadReverseConfig();
  await migrate(cfg.databaseUrl);

  const pipeline = new ReversePipeline(cfg);
  const app = Fastify({ logger: false });

  // A bodyless POST arrives with no Content-Type and Fastify answers 415 before the handler.
  // Every button here is a command with no payload, so without this they would all be dead.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) return done(null, {});
    try { done(null, JSON.parse(text)); } catch { done(null, {}); }
  });

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

  // The stylesheet is shared with the forward dashboard — same design, and one file to change.
  app.get("/app.css", async (_req, reply) => {
    reply.type("text/css; charset=utf-8");
    return readFileSync(join(HERE, "..", "..", "syncdemo", "ui", "app.css"), "utf8");
  });
  app.get("/app.js", async (_req, reply) => {
    reply.type("text/javascript; charset=utf-8");
    return readFileSync(join(UI_DIR, "app.js"), "utf8");
  });

  app.get("/api/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (data: unknown) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    send({ type: "hello", config: publicReverseConfig(cfg) });
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": keepalive\n\n");
    }, 15_000);
    req.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    await new Promise(() => { /* until the client disconnects */ });
  });

  app.get("/api/snapshot", async () => pipeline.snapshot());
  app.get("/api/config", async () => publicReverseConfig(cfg));

  /** Re-read Workday. Read-only; safe to press at any time. */
  app.post("/api/workday/refresh", async (_req, reply) => {
    try { return reply.send(await pipeline.refreshFromWorkday()); } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * Import one Workday member into BambooHR.
   *
   * One per request, capped by REVDEMO_MAX_PER_REQUEST (default 1). A BambooHR create is
   * permanent and consumes a seat, so bulk import is not something to expose behind a button.
   */
  app.post<{ Params: { id: string } }>("/api/import/:id", async (req, reply) => {
    try {
      return reply.send(await pipeline.importMember(req.params.id));
    } catch (e) {
      const retryable = e instanceof StageFailure ? e.retryable : true;
      return reply.code(502).send({
        error: e instanceof Error ? e.message : String(e), retryable,
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/import/:id/retry", async (req, reply) => {
    const out = await pipeline.retry(req.params.id);
    return reply.code(out.ok ? 200 : 502).send(out);
  });

  app.post("/api/reset", async () => { await pipeline.reset(); return { ok: true }; });

  app.get("/api/health", async () => {
    const s = await pipeline.snapshot();
    return {
      ok: s.systems.postgres.health.ok,
      systems: Object.fromEntries(
        Object.entries(s.systems).map(([k, v]) => [k, { mode: v.mode, ok: v.health.ok }])),
    };
  });

  return { app, cfg, pipeline };
}

const entry = process.argv[1];
const isMain = Boolean(entry) && import.meta.url === pathToFileURL(entry as string).href;
if (isMain) {
  const { app, cfg, pipeline } = await buildReverseServer();
  await app.listen({ port: cfg.port, host: "0.0.0.0" });

  const pub = publicReverseConfig(cfg);
  const line = (label: string, v: { mode: string; target?: string; reason?: string }) =>
    `    ${label.padEnd(11)} ${v.mode.toUpperCase().padEnd(5)} ${v.target ?? ""}${v.reason ? `  (${v.reason})` : ""}`;
  console.log(`\n  Reverse pipeline (Workday -> BambooHR) on http://localhost:${cfg.port}\n`);
  console.log(line("Workday", pub.systems.workday));
  console.log(line("Striim", pub.systems.striim));
  console.log(line("PostgreSQL", pub.systems.postgres));
  console.log(line("BambooHR", pub.systems.bamboohr));
  console.log(`\n  emails synthesised at @${cfg.emailDomain}`);
  console.log("  BambooHR creates are PERMANENT — the API has no delete, only termination.\n");

  // Read Workday once at boot so the dashboard has candidates, then keep watching. Both are
  // read-only; the IMPORT is never automatic, because a BambooHR create is permanent.
  pipeline.refreshFromWorkday().catch((e: Error) => console.log(`  initial Workday read failed: ${e.message}`));
  pipeline.startWorkdayPoller();
  if (cfg.workdayPollMs > 0) {
    console.log(`  watching Workday every ${Math.round(cfg.workdayPollMs / 1000)}s for new members `
              + "(read-only — importing stays a manual click)\n");
  }

  const shutdown = async () => {
    pipeline.stopWorkdayPoller();
    await app.close(); await closePool(); process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
