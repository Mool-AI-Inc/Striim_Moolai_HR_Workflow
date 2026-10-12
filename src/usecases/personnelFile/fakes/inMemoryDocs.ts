/**
 * In-memory document-source fake — Layer-B scaffolding the UC3 workflow test injects.
 * @lifespan THROWAWAY — lives under src/ but is never imported by a prod entrypoint; a test double only.
 * @responsibility Stand in for BOTH Vetty (ScreeningConnector) and WorkBright (OnboardingDocsConnector) — a
 *   single seeded id → ScreeningDoc map, since the two real connectors share the same "fetch bytes by id"
 *   shape. An unseeded id throws, mirroring a real 404.
 */
import type { ScreeningConnector, OnboardingDocsConnector } from "../../../platform/connectors/types.js";
import type { ScreeningDoc } from "../../../platform/domain/types.js";

export class InMemoryDocs implements ScreeningConnector, OnboardingDocsConnector {
  private readonly docs = new Map<string, ScreeningDoc>();

  constructor(seed: Record<string, ScreeningDoc> = {}) {
    for (const [id, doc] of Object.entries(seed)) this.docs.set(id, doc);
  }

  async getScreening(id: string): Promise<ScreeningDoc> {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`no screening doc seeded for ${id}`);
    return doc;
  }

  async getSubmissionFile(id: string): Promise<ScreeningDoc> {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`no submission doc seeded for ${id}`);
    return doc;
  }
}
