/**
 * UC8 startingSoonScan workflow tests (time-skipping) — idempotent Slack invite, role channels.
 * @lifespan THROWAWAY — temporal-tier test only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";
import { InMemorySlack } from "../../src/usecases/startingSoonScan/fakes/inMemorySlack.js";
import { roleChannels } from "../../src/usecases/startingSoonScan/roleChannels.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import type { EmployeeRecord } from "../../src/platform/domain/types.js";
import { startingSoonScan } from "../../src/usecases/startingSoonScan/workflow.js";

const TASK_QUEUE = "uc8-slack-test";
const TODAY = "2026-08-18";
const TOMORROW = "2026-08-19";

const STARTER = makeEmployee({ employeeId: "ST-1", email: "st1@instantteams.test", hireDate: TOMORROW, employeeType: "RFT", costCenter: "CC-OPS" });
const OTHER = makeEmployee({ employeeId: "NOPE", email: "nope@instantteams.test", hireDate: "2020-01-01" });

describe("UC8 startingSoonScan workflow", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let runPromise: Promise<void>;
  let slack: InMemorySlack;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const hris = new InMemoryHris([STARTER, OTHER]);
    slack = new InMemorySlack();
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../../src/usecases/startingSoonScan/workflow.ts", import.meta.url)),
      activities: {
        listEmployees: (companyId: string): Promise<EmployeeRecord[]> => hris.listEmployees(companyId),
        inviteToSlack: (employee: EmployeeRecord) => slack.invite({ email: employee.email, channelIds: roleChannels(employee), kind: "member" }),
      },
    });
    runPromise = worker.run();
  });

  afterAll(async () => {
    worker.shutdown();
    await runPromise.catch(() => {});
    await env.teardown();
  });

  it("invites exactly tomorrow's starter, to their role channels", async () => {
    await env.client.workflow.execute(startingSoonScan, {
      taskQueue: TASK_QUEUE,
      workflowId: "uc8-scan-1",
      args: [{ companyId: "C1", todayISO: TODAY }],
    });

    expect(slack.invites).toHaveLength(1);
    expect(slack.invites[0]).toEqual({ email: STARTER.email, channelIds: roleChannels(STARTER), kind: "member" });
  });

  it("a second run does not duplicate the invite (idempotent — already a member)", async () => {
    await env.client.workflow.execute(startingSoonScan, {
      taskQueue: TASK_QUEUE,
      workflowId: "uc8-scan-2",
      args: [{ companyId: "C1", todayISO: TODAY }],
    });

    expect(slack.invites).toHaveLength(1); // still just the one recorded by the first run
  });
});
