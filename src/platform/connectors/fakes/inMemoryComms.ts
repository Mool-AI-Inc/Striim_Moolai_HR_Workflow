/**
 * In-memory Comms fake — Layer-B scaffolding that module workflow tests inject.
 * @lifespan THROWAWAY — lives under src/ but is never imported by a prod entrypoint; a test double only.
 * @responsibility Record every transactional send in `.sent` and return a deterministic receipt.
 */
import type { CommsConnector } from "../types.js";
import type { TransactionalEmail, SendReceipt } from "../../domain/types.js";

export class InMemoryComms implements CommsConnector {
  readonly sent: TransactionalEmail[] = [];
  async sendTransactional(email: TransactionalEmail): Promise<SendReceipt> {
    this.sent.push(email);
    return { messageId: `mem-${this.sent.length}`, submittedAt: new Date().toISOString() };
  }
}
