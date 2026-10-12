/**
 * In-memory SMS fake — Layer-B scaffolding module workflow tests inject.
 * @lifespan THROWAWAY — a test double only; never imported by a prod entrypoint.
 * @responsibility Record every send in `.sent` and return a deterministic receipt.
 */
import type { SmsConnector } from "../../../platform/connectors/types.js";
import type { SmsMessage } from "../../../platform/domain/types.js";

export class InMemorySms implements SmsConnector {
  readonly sent: SmsMessage[] = [];
  async sendSms(msg: SmsMessage): Promise<{ messageId: string }> { this.sent.push(msg); return { messageId: `sms-${this.sent.length}` }; }
}
