/**
 * Scheduler — ensures a Temporal Schedule per module `schedule` trigger.
 * @lifespan PRODUCTION — not on Plans 2/3's critical path; completes the host for Plan 1's demo.
 * @responsibility Idempotently create a cron Schedule per schedule-trigger (by convention its id names both the
 *   schedule and the workflow type the module registers).
 */
import type { UseCaseModule, HostCtx } from "./usecase.js";

export async function ensureSchedules(modules: readonly UseCaseModule[], host: HostCtx): Promise<void> {
  const client = host.temporal;
  for (const m of modules) {
    for (const t of m.triggers ?? []) {
      if (t.kind !== "schedule") continue;
      try {
        await client.schedule.getHandle(t.id).describe();  // already exists → leave it
        continue;
      } catch {
        // not found — create below
      }
      await client.schedule.create({
        scheduleId: t.id,
        spec: { cronExpressions: [t.cron] },
        action: { type: "startWorkflow", workflowType: t.id, taskQueue: "main", workflowId: `sched:${t.id}` },
      });
    }
  }
}
