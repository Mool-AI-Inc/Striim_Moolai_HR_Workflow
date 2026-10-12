/**
 * The platform-owned connector bag — hris (Paylocity) + comms (Postmark), built from env.
 * @lifespan PRODUCTION — imports NO usecases/* (module connectors self-construct in their own activities.ts),
 *   so the isolation rail holds with no whitelist for the connector registry (spec §F2).
 * @responsibility Construct the two connectors the host uses centrally, pointed at the simulator (demo) or real
 *   vendors (live) by PLATFORM_MODE.
 */
import type { ConnectorRegistry } from "./types.js";
import { loadEnv, type Env } from "../config/env.js";
import { PaylocityConnector } from "./paylocity/paylocityConnector.js";
import { PostmarkCommsConnector } from "./comms/postmarkCommsConnector.js";

export function buildConnectorRegistry(env: Env = loadEnv()): ConnectorRegistry {
  return {
    hris: new PaylocityConnector(env.paylocity),
    comms: new PostmarkCommsConnector(env.postmark),
  };
}
