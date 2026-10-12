/**
 * Slack admin connector — Enterprise Grid `admin.users.invite` (idempotent invite-to-workspace).
 * @lifespan PRODUCTION — the UC8 module-owned connector; the simulator implements this exact contract in demo.
 * @responsibility POST {baseUrl}/admin.users.invite; treat an already-a-member response (`already: true` or
 *   an `already_in_team` error) as success — invites never duplicate. `admin.users.invite` is Enterprise-Grid-only;
 *   Grid-vs-SCIM is a prod-cutover decision (the MVP writes to the Grid contract and simulates it).
 */
import type { SlackAdminConnector } from "../../../platform/connectors/types.js";
import type { SlackInvite } from "../../../platform/domain/types.js";

export interface SlackConfig { baseUrl: string; token: string; }

export class SlackConnector implements SlackAdminConnector {
  constructor(private readonly cfg: SlackConfig) {}

  async invite(inv: SlackInvite): Promise<{ invited: boolean; alreadyMember: boolean }> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/admin.users.invite`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
        body: JSON.stringify({ email: inv.email, channel_ids: inv.channelIds, is_restricted: inv.kind === "guest" }),
      });
    } catch (e) {
      throw new Error(`slack network error: ${(e as Error).message}`);  // retryable
    }
    if (res.status === 429 || res.status >= 500) throw new Error(`slack retryable ${res.status}`);  // 429/5xx → retry
    const json = (await res.json()) as { ok?: boolean; already?: boolean; error?: string };
    if (json.error === "already_in_team" || json.already === true) return { invited: false, alreadyMember: true };
    if (json.ok !== true) throw new Error(`slack invite failed: ${json.error ?? "unknown error"}`);
    return { invited: true, alreadyMember: false };
  }
}
