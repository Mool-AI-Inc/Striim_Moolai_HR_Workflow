/**
 * Host ingress — external webhook adapters that emit logical events, fanned out to every matching module trigger.
 * @lifespan PRODUCTION.
 * @responsibility Authenticate an incoming Paylocity webhook (Basic Auth — no HMAC is sent), emit a logical event,
 *   run every module `event` trigger whose event matches (idempotent — swallow WorkflowExecutionAlreadyStartedError),
 *   and mount each module's `webhook` triggers. Pure: the host + auth verifier are injected (composition root wires them).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { UseCaseModule, HostCtx, EventPayload } from "./usecase.js";

export interface IngressOptions {
  /** Verifies the Paylocity webhook Authorization header. Fail-closed default — the composition root injects the
   *  concrete PaylocityConnector.verifyWebhookAuth (a platform/* method, not on the hris port). */
  verifyPaylocityAuth?: (header: string | undefined) => boolean;
}

export function buildIngress(modules: readonly UseCaseModule[], host: HostCtx, opts: IngressOptions = {}): FastifyInstance {
  const app = Fastify();
  const verify = opts.verifyPaylocityAuth ?? (() => false);

  async function emit(event: string, payload: EventPayload): Promise<void> {
    for (const m of modules) {
      for (const t of m.triggers ?? []) {
        if (t.kind !== "event" || t.event !== event) continue;
        try {
          await t.start(payload, host);
        } catch (e) {
          if (e instanceof WorkflowExecutionAlreadyStartedError) continue;  // idempotent: same employee twice → success
          throw e;
        }
      }
    }
  }

  app.post("/webhooks/paylocity", async (req, reply) => {
    if (!verify(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const b = req.body as { companyId?: string; employeeId?: string };
    await emit("employee.new-hire", { companyId: String(b.companyId), employeeId: String(b.employeeId) });
    return reply.code(202).send({ ok: true });
  });

  app.post("/webhooks/task-complete", async (req, reply) => {
    const b = req.body as { companyId?: string; employeeId?: string };
    await emit("employee.task-complete", { companyId: String(b.companyId), employeeId: String(b.employeeId) });
    return reply.code(202).send({ ok: true });
  });

  // Mount each module's own webhook triggers.
  for (const m of modules) {
    for (const t of m.triggers ?? []) {
      if (t.kind !== "webhook") continue;
      app.route({
        method: t.method,
        url: t.path,
        handler: async (req, reply) => { await t.handler(req.body, host); return reply.code(202).send({ ok: true }); },
      });
    }
  }

  return app;
}
