/**
 * Google Drive connector — file upload only (spec §8: automation never changes sharing/permissions).
 * @lifespan PRODUCTION — the UC3 module-owned connector; the simulator implements this exact contract in demo.
 * @responsibility POST {baseUrl}/files → { fileId }, dropping bytes into an already-secured folder id
 *   (supportsAllDrives). Exposes ONLY putFile — no setPermissions method exists on this class, by design;
 *   report/folder access is a human action outside the system.
 */
import type { DriveConnector } from "../../../platform/connectors/types.js";

export interface DriveConfig { baseUrl: string; token: string; }

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 150;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GoogleDriveConnector implements DriveConnector {
  constructor(private readonly cfg: DriveConfig) {}

  async putFile(folderId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ fileId: string }> {
    const res = await this.fetchWithRetry(`${this.cfg.baseUrl}/files`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
      body: JSON.stringify({
        folderId, name, contentType, supportsAllDrives: true,
        bytes: Buffer.from(bytes).toString("base64"),
      }),
    });
    return (await res.json()) as { fileId: string };
  }

  /** Retries network errors and 429/5xx with exponential backoff; a non-retryable 4xx throws immediately. */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(url, init);
      } catch (e) {
        lastErr = e;  // network error — retryable
      }
      if (res) {
        if (res.ok) return res;
        if (res.status !== 429 && res.status < 500) throw new Error(`drive putFile failed: ${res.status}`);
        lastErr = new Error(`drive retryable ${res.status}`);
      }
      if (attempt < MAX_ATTEMPTS - 1) await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
