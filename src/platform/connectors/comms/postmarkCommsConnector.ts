/**
 * Postmark comms connector — transactional template email with retry classification.
 * @lifespan PRODUCTION — the shared email connector (the sendEmail activity builds it).
 * @responsibility Send /email/withTemplate; success ONLY on HTTP 200 + ErrorCode 0. Classify failures so the
 *   Temporal activity retries the right ones: 4xx/422 → PostmarkPermanentError (never retry); 429/5xx/network → plain Error (retry).
 */
import type { CommsConnector } from "../types.js";
import type { TransactionalEmail, SendReceipt } from "../../domain/types.js";

/** Non-retryable send failure — matches the activity's nonRetryableErrorTypes. */
export class PostmarkPermanentError extends Error {
  constructor(message: string) { super(message); this.name = "PostmarkPermanentError"; }
}

export interface PostmarkConfig { baseUrl: string; serverToken: string; from: string; }

export class PostmarkCommsConnector implements CommsConnector {
  constructor(private readonly cfg: PostmarkConfig) {}

  async sendTransactional(email: TransactionalEmail): Promise<SendReceipt> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/email/withTemplate`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "X-Postmark-Server-Token": this.cfg.serverToken },
        body: JSON.stringify({
          From: this.cfg.from, To: email.to, TemplateAlias: email.templateAlias,
          TemplateModel: email.model, Metadata: { idempotencyKey: email.idempotencyKey },  // correlation only; our ledger dedupes
        }),
      });
    } catch (e) {
      throw new Error(`postmark network error: ${(e as Error).message}`);  // retryable
    }
    if (res.status === 429 || res.status >= 500) throw new Error(`postmark retryable ${res.status}`);  // 429/5xx → retry
    if (res.status >= 400) throw new PostmarkPermanentError(`postmark permanent ${res.status}`);         // other 4xx/422 → never retry
    const json = (await res.json()) as { ErrorCode: number; MessageID?: string; SubmittedAt?: string };
    if (json.ErrorCode !== 0) throw new PostmarkPermanentError(`postmark ErrorCode ${json.ErrorCode}`);
    return { messageId: json.MessageID ?? "", submittedAt: json.SubmittedAt ?? new Date().toISOString() };
  }
}
