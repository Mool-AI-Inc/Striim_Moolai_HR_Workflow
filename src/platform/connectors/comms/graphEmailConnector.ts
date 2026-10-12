/** @lifespan PRODUCTION — send transactional email via the native Graph mail component (GraphMailer).
 * Renders a template alias, wraps + sends it through Microsoft Graph directly — no external service. */
import { renderEmail, escapeHtml, type EmailModel } from "./emailTemplates.js";
import { GraphMailer, type GraphMailConfig, type MailAttachment } from "./graphMail.js";

export interface GraphEmailOptions extends GraphMailConfig {
  redirectTo?: string;             // demo: deliver ALL mail here; the intended recipient is shown in the body
}

export class GraphEmailConnector {
  private readonly mailer: GraphMailer;
  constructor(private readonly opts: GraphEmailOptions) {
    this.mailer = new GraphMailer(opts);
  }

  /** Render `templateAlias` + `model` and send via Graph, with optional attachments. Rejects on a provider failure. */
  async send(toEmail: string, toName: string, templateAlias: string, model: EmailModel, attachments?: MailAttachment[]): Promise<void> {
    const { subject, html } = renderEmail(templateAlias, model);
    const to = this.opts.redirectTo ?? toEmail;
    const banner = this.opts.redirectTo
      ? `<p style="margin:0 0 14px;padding:10px 14px;background:#FAE2D3;border-radius:8px;font:14px system-ui,sans-serif">Demo delivery — intended for <strong>${escapeHtml(toName)}</strong> &lt;${escapeHtml(toEmail)}&gt;</p>`
      : "";
    await this.mailer.sendReport({ toEmail: to, toName, subject, bodyHtml: banner + html, attachments });
  }
}
