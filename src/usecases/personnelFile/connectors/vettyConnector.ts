/**
 * Vetty screening connector — background-check document retrieval.
 * @lifespan PRODUCTION — the UC3 module-owned connector; the simulator implements this exact contract in demo.
 * @responsibility GET {baseUrl}/screening/{id} → ScreeningDoc (PDF bytes); a thin fetch with retry/backoff on
 *   network errors and 429/5xx. Vetty needs a static egress IP allowlisted in prod (README note — a live
 *   cutover concern, not code).
 */
import type { ScreeningConnector } from "../../../platform/connectors/types.js";
import type { ScreeningDoc } from "../../../platform/domain/types.js";

export interface VettyConfig { baseUrl: string; token: string; }

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 150;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VettyConnector implements ScreeningConnector {
  constructor(private readonly cfg: VettyConfig) {}

  async getScreening(id: string): Promise<ScreeningDoc> {
    const res = await this.fetchWithRetry(`${this.cfg.baseUrl}/screening/${id}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "application/pdf";
    return { filename: `background-check-${id}.pdf`, contentType, bytes };
  }

  /** Retries network errors and 429/5xx with exponential backoff; a non-retryable 4xx throws immediately. */
  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(url, { headers: { authorization: `Bearer ${this.cfg.token}` } });
      } catch (e) {
        lastErr = e;  // network error — retryable
      }
      if (res) {
        if (res.ok) return res;
        if (res.status !== 429 && res.status < 500) throw new Error(`vetty getScreening failed: ${res.status}`);
        lastErr = new Error(`vetty retryable ${res.status}`);
      }
      if (attempt < MAX_ATTEMPTS - 1) await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
