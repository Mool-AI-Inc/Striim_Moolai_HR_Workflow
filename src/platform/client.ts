/**
 * The shared Temporal Client — the unified @temporalio/client Client (spec §F1).
 * @lifespan PRODUCTION — one instance exposes both .workflow.* (triggers call host.temporal.workflow.start)
 *   and .schedule.* (the scheduler). A bare WorkflowClient has neither surface and would not compile the contract.
 */
import { Client, Connection } from "@temporalio/client";
import { loadEnv } from "./config/env.js";

let client: Client | undefined;

export async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: loadEnv().temporalAddress });
    client = new Client({ connection });
  }
  return client;
}
