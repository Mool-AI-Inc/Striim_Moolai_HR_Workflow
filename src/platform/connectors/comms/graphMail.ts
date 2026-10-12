/** @lifespan PRODUCTION — native Microsoft Graph mail component (ported from moolai-email-connector).
 * ALL Graph/identity calls live here: app-only (client-credentials) token + POST /users/{sender}/sendMail,
 * with the connector's branded "do-not-reply" shell and bounded retry on transient failures. No external
 * service, no MSAL/httpx — Node's native fetch does both the token call and the send. */

export interface GraphMailConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderEmail: string;                 // mail is sent AS this M365 mailbox, e.g. platform@moolai.ai
  fromDisplayName?: string;            // default "MoolAI Platform"
  replyToEmail?: string;              // optional Reply-To; body always carries the do-not-reply notice
  platformName?: string;              // branding in the shell/footer, default "MoolAI"
  authority?: string;                 // default https://login.microsoftonline.com
  graphBaseUrl?: string;              // default https://graph.microsoft.com/v1.0
  saveToSentItems?: boolean;          // default true
  maxRetries?: number;                // retries AFTER the first attempt (total = maxRetries + 1), default 2
  retryBackoffSeconds?: number;       // exponential base with jitter, default 0.5
}

/** Any Graph / token-acquisition failure (never carries the secret). */
export class GraphError extends Error {}

/** An attachment over Graph's ~3 MB inline-attachment ceiling (larger needs an upload session, unsupported). */
export class AttachmentTooLargeError extends Error {}

export interface MailAttachment {
  filename: string;
  content: Uint8Array;             // raw bytes (base64-encoded here)
  contentType?: string;           // guessed from the filename extension when omitted
}

const _TRANSIENT = new Set([429, 500, 502, 503, 504]);
const _MAX_BACKOFF_MS = 30_000;
const _MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;   // Graph inline ceiling; larger needs an upload session
const _CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const _esc = (v: unknown): string =>
  v == null ? "" : String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function guessContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return _CONTENT_TYPES[dot !== -1 ? filename.slice(dot).toLowerCase() : ""] ?? "application/octet-stream";
}

/** Build a #microsoft.graph.fileAttachment (base64-encoded). Throws AttachmentTooLargeError over the inline limit. */
export function buildFileAttachment(a: MailAttachment): Record<string, unknown> {
  if (a.content.byteLength > _MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(`attachment '${a.filename}' is ${a.content.byteLength} bytes, over the ${_MAX_ATTACHMENT_BYTES}-byte limit`);
  }
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.contentType ?? guessContentType(a.filename),
    contentBytes: Buffer.from(a.content).toString("base64"),
  };
}

export class GraphMailer {
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(private readonly cfg: GraphMailConfig) {}

  /** Wrap a TRUSTED caller-rendered HTML fragment in the branded shell + mandatory do-not-reply footer.
   * `inner` is inserted VERBATIM (the caller owns + escapes it); only the platform name/footer are escaped. */
  wrapReportBody(inner: string): string {
    const platform = _esc(this.cfg.platformName ?? "MoolAI");
    return `<!DOCTYPE html>
<html>
  <body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:720px;margin:0 auto;padding:24px;">
      <div style="background:#ffffff;border-radius:10px;padding:28px;border:1px solid #e5e7eb;color:#111827;line-height:1.5;">
        <div style="text-align:center;margin:0 0 18px;"><a href="https://moolai.ai" target="_blank" style="text-decoration:none;display:inline-block;"><span style="vertical-align:middle;color:#111111;font-weight:700;font-size:18px;letter-spacing:.02em;">${platform}</span></a></div>
        ${inner}
      </div>
      <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;text-align:center;">
        This is an automated message from ${platform}. Please do not reply to this email.
        Replies to this address are not monitored.
      </p>
    </div>
  </body>
</html>`;
  }

  /** Send a caller-rendered HTML report email. `bodyHtml` is inserted verbatim into the branded shell;
   * optional attachments are base64-inlined. Rejects with GraphError (provider) or AttachmentTooLargeError. */
  async sendReport(args: { toEmail: string; toName?: string; subject: string; bodyHtml: string; attachments?: MailAttachment[] }): Promise<void> {
    const message: Record<string, unknown> = {
      subject: args.subject,
      body: { contentType: "HTML", content: this.wrapReportBody(args.bodyHtml) },
      toRecipients: [{ emailAddress: { address: args.toEmail, name: args.toName || args.toEmail } }],
      from: { emailAddress: { address: this.cfg.senderEmail, name: this.cfg.fromDisplayName ?? "MoolAI Platform" } },
    };
    if (this.cfg.replyToEmail) message.replyTo = [{ emailAddress: { address: this.cfg.replyToEmail } }];
    if (args.attachments?.length) message.attachments = args.attachments.map(buildFileAttachment);
    await this.sendMail(message);
  }

  /** App-only client-credentials token, cached in-process until ~60s before expiry. */
  private async acquireToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAtMs) return this.token.value;
    const authority = this.cfg.authority ?? "https://login.microsoftonline.com";
    const res = await fetch(`${authority}/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    }).catch((e: Error) => { throw new GraphError(`token acquisition failed: network error ${e.name}`); });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      throw new GraphError(`token acquisition failed: ${data.error ?? res.status} ${String(data.error_description ?? "").slice(0, 200)}`);
    }
    this.token = { value: data.access_token, expiresAtMs: now + (data.expires_in ?? 3600) * 1000 - 60_000 };
    return this.token.value;
  }

  private backoffMs(attempt: number, retryAfter: number | null): number {
    if (retryAfter != null) return Math.min(retryAfter * 1000, _MAX_BACKOFF_MS);
    const base = (this.cfg.retryBackoffSeconds ?? 0.5) * 1000 * 2 ** (attempt - 1);
    return Math.min(base + Math.random() * base * 0.25, _MAX_BACKOFF_MS);
  }

  /** POST /users/{sender}/sendMail, retrying transient failures (429/5xx/network) with backoff. */
  private async sendMail(message: Record<string, unknown>): Promise<void> {
    const token = await this.acquireToken();
    const graph = this.cfg.graphBaseUrl ?? "https://graph.microsoft.com/v1.0";
    const url = `${graph}/users/${encodeURIComponent(this.cfg.senderEmail)}/sendMail`;
    const payload = JSON.stringify({ message, saveToSentItems: this.cfg.saveToSentItems ?? true });
    const totalAttempts = Math.max(this.cfg.maxRetries ?? 2, 0) + 1;
    let lastDetail = "";
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: payload });
      } catch (e) {
        lastDetail = `network error: ${(e as Error).name}`;
        if (attempt < totalAttempts) { await sleep(this.backoffMs(attempt, null)); continue; }
        throw new GraphError(`Graph sendMail failed after ${attempt} attempts: ${lastDetail}`);
      }
      if (resp.status === 200 || resp.status === 202) return;   // 202 Accepted = sent
      if (_TRANSIENT.has(resp.status) && attempt < totalAttempts) {
        const ra = resp.headers.get("Retry-After");
        await sleep(this.backoffMs(attempt, ra && /^\d+$/.test(ra) ? Number(ra) : null));
        lastDetail = `HTTP ${resp.status}`;
        continue;
      }
      throw new GraphError(`Graph sendMail failed: HTTP ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 300)}`);
    }
    throw new GraphError(`Graph sendMail failed: ${lastDetail}`);   // unreachable; loop returns or throws
  }
}
