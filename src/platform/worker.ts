/**
 * The Temporal worker — merges every enabled module's activities with the shared ones and runs them.
 * @lifespan PRODUCTION.
 * @responsibility Enforce the flat activity-name namespace (throw on a collision at startup, spec §F3), then
 *   create a Worker whose workflowsPath is the physical .ts bundle (Temporal statSyncs the literal string).
 */
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { MODULES } from "./registry.js";
import * as shared from "./activities.js";
import type { UseCaseModule } from "./usecase.js";

type ActivityMap = Record<string, (...a: unknown[]) => Promise<unknown>>;

/** Merge shared + module activities into one flat registry; throw on a name collision (spec §F3). */
export function mergeActivities(modules: readonly UseCaseModule[]): ActivityMap {
  const seen = new Set(Object.keys(shared));                                       // the six reserved shared names
  for (const m of modules) for (const name of Object.keys(m.activities)) {         // a flat global namespace —
    if (seen.has(name)) throw new Error(`activity name collision: "${name}" (module ${m.name})`);  // fail fast if a
    seen.add(name);                                                                // module shadows a shared activity
  }                                                                                // or another module's
  return Object.assign({}, shared, ...modules.map((m) => m.activities)) as ActivityMap;
}

/** The physical .ts workflows-bundle path Temporal statSyncs + swc-compiles. */
export function workflowsBundlePath(): string {
  return fileURLToPath(new URL("./workflows.bundle.ts", import.meta.url));
}

export async function startWorker(): Promise<void> {
  const worker = await Worker.create({
    taskQueue: "main",
    activities: mergeActivities(MODULES),
    workflowsPath: workflowsBundlePath(),
  });
  await worker.run();
}
