/**
 * UC8 module-owned activities — the Slack connector built from env, exposed as one activity.
 * @lifespan PRODUCTION
 * @responsibility Build SlackConnector ONCE from loadEnv().slack (demo → simulator, live → real Slack Grid API)
 *   inside this module's own activities.ts — never injected from the host, never built elsewhere — then map the
 *   employee to its role channels and call the connector. Activity name `inviteToSlack` is globally unique.
 */
import type { EmployeeRecord } from "../../platform/domain/types.js";
import { loadEnv } from "../../platform/config/env.js";
import { SlackConnector } from "./connectors/slackAdminConnector.js";
import { roleChannels } from "./roleChannels.js";

const env = loadEnv();
const slack = new SlackConnector(env.slack);

export async function inviteToSlack(employee: EmployeeRecord): Promise<{ invited: boolean; alreadyMember: boolean }> {
  return slack.invite({ email: employee.email, channelIds: roleChannels(employee), kind: "member" });
}
