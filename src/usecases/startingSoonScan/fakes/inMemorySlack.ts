/**
 * In-memory Slack admin fake — Layer-B scaffolding the UC8 workflow test injects.
 * @lifespan THROWAWAY — lives under src/ but is never imported by a prod entrypoint; a test double only.
 * @responsibility Mimic the simulator's admin.users.invite contract: idempotent by email, records every
 *   first-time invite in `.invites`.
 */
import type { SlackAdminConnector } from "../../../platform/connectors/types.js";
import type { SlackInvite } from "../../../platform/domain/types.js";

export class InMemorySlack implements SlackAdminConnector {
  readonly invites: SlackInvite[] = [];
  private readonly invited = new Set<string>();

  async invite(inv: SlackInvite): Promise<{ invited: boolean; alreadyMember: boolean }> {
    const alreadyMember = this.invited.has(inv.email);
    if (!alreadyMember) {
      this.invited.add(inv.email);
      this.invites.push(inv);
    }
    return { invited: !alreadyMember, alreadyMember };
  }
}
