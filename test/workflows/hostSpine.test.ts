import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { mergeActivities, workflowsBundlePath } from "../../src/platform/worker.js";
import type { UseCaseModule } from "../../src/platform/usecase.js";
import { sampleWorkflow } from "./fixtures/sampleWorkflow.js";

const sampleModule: UseCaseModule = {
  name: "sample",
  workflows: { sampleWorkflow },
  activities: { sampleActivity: async () => "pong" },
  triggers: [{ kind: "event", event: "sample.event", start: async () => {} }],
};

describe("host spine", () => {
  it("workflowsBundlePath is a physical .ts file", () => {
    const p = workflowsBundlePath();
    expect(p.endsWith(".ts")).toBe(true);
    expect(existsSync(p)).toBe(true);
  });

  it("merges shared + module activities into one flat registry (all six reserved names present)", () => {
    const merged = mergeActivities([sampleModule]);
    expect(Object.keys(merged)).toEqual(expect.arrayContaining([
      "sendEmail", "getEmployee", "listEmployees", "alarmDidNotSend", "registerPending", "resolvePending", "sampleActivity",
    ]));
  });

  it("throws on an activity-name collision with a reserved shared name", () => {
    const shadow: UseCaseModule = { name: "bad", workflows: {}, activities: { sendEmail: async () => "x" } };
    expect(() => mergeActivities([shadow])).toThrow(/collision/i);
  });

  it("wires an arbitrary module and runs its workflow to completion (time-skipping)", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    try {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: "host-spine-test",
        workflowsPath: fileURLToPath(new URL("./fixtures/sampleWorkflow.ts", import.meta.url)),
        activities: mergeActivities([sampleModule]),
      });
      const result = await worker.runUntil(
        env.client.workflow.execute(sampleWorkflow, { taskQueue: "host-spine-test", workflowId: "sample-1" }),
      );
      expect(result).toBe("pong");
    } finally {
      await env.teardown();
    }
  });
});
