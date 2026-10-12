/**
 * ActiveCampaign SMS connector.
 * @lifespan PRODUCTION — the real SMS send path; only baseUrl differs demo↔live. Consent is enforced upstream.
 * @responsibility POST a text message to the vendor endpoint.
 */
import type { SmsConnector } from "../../../platform/connectors/types.js";
import type { SmsMessage } from "../../../platform/domain/types.js";

export class AcSmsConnector implements SmsConnector {
  constructor(private readonly opts: { baseUrl: string; apiToken: string }) {}
  async sendSms(msg: SmsMessage): Promise<{ messageId: string }> {
    const res = await fetch(`${this.opts.baseUrl}/sms/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiToken}` },
      body: JSON.stringify({ to: msg.to, body: msg.body, idempotencyKey: msg.idempotencyKey }),
    });
    if (!res.ok) throw new Error(`sms send failed: ${res.status}`);
    const j = (await res.json()) as { MessageID: string };            // simulator returns Postmark-style PascalCase MessageID
    return { messageId: j.MessageID };
  }
}
