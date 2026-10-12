/** @lifespan PRODUCTION — subject + HTML body per template alias. The connector wraps this in its branded shell. */
export type EmailModel = Record<string, string>;
export interface RenderedEmail { subject: string; html: string; }

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const TEMPLATES: Record<string, (m: EmailModel) => RenderedEmail> = {
  welcome: (m) => ({
    subject: `Welcome to Instant Teams, ${m.firstName ?? "there"}!`,
    html: `<h1>Welcome aboard, ${escapeHtml(m.firstName ?? "there")} 👋</h1>
<p>We're thrilled to have you on the team. Your onboarding is underway — you'll get everything you need over the next few days.</p>
<p>If anything looks off, just reply to your HR contact.</p>`,
  }),
  "day60-compliance": (m) => ({
    subject: `Action needed: your Day-60 compliance notice`,
    html: `<h1>Day-60 compliance notice</h1>
<p>Hi ${escapeHtml(m.firstName ?? "there")}, you've reached day 60 with us. Please review and acknowledge your compliance items to stay in good standing.</p>
<p>This is a required, time-sensitive notice.</p>`,
  }),
  "welcome-sms": (m) => ({
    subject: `👋 A quick welcome, ${m.firstName ?? "there"}`,
    html: `<p>Hi ${escapeHtml(m.firstName ?? "there")} — welcome to Instant Teams! (This is the welcome we'd normally <em>text</em> you, delivered by email for the demo.)</p>`,
  }),
  birthday: (m) => ({
    subject: `🎂 Happy birthday, ${m.firstName ?? "there"}!`,
    html: `<h1>Happy birthday, ${escapeHtml(m.firstName ?? "there")}! 🎉</h1>
<p>The whole Instant Teams team is wishing you a wonderful day. Thanks for all you do — enjoy your celebration!</p>`,
  }),
  anniversary: (m) => ({
    subject: `🎉 Happy work anniversary, ${m.firstName ?? "there"}!`,
    html: `<h1>Congratulations on your work anniversary, ${escapeHtml(m.firstName ?? "there")}! 🎊</h1>
<p>Another year of great work with Instant Teams. We're grateful to have you on the team — here's to the year ahead!</p>`,
  }),
  "uc4-report-ready": (m) => ({
    subject: `Monthly finance report ready — ${m.month ?? ""}`,
    html: `<h1>Monthly finance report — ${escapeHtml(m.month ?? "")}</h1>
<p>The new-hire finance report for ${escapeHtml(m.month ?? "this month")} is ready for your review${m.transitionCount ? `, with <strong>${escapeHtml(m.transitionCount)}</strong> cost-center transition(s) highlighted` : ""}.</p>
<p>Open it here: <a href="${escapeHtml(m.location ?? "#")}">${escapeHtml(m.location ?? "the report")}</a>. Releasing access to Finance is a manual step — the automation never grants sharing.</p>`,
  }),
  "onboarding-packet": (m) => {
    const docs = (m.docs ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    const list = docs.length
      ? `<ul>${docs.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
      : "<p>No documents were selected.</p>";
    return {
      subject: `Your onboarding packet is ready${m.packetId ? ` (${m.packetId})` : ""}`,
      html: `<h1>Your onboarding packet, ${escapeHtml(m.firstName ?? "there")}</h1>
<p>Your onboarding packet <strong>${escapeHtml(m.packetId ?? "")}</strong> has been assigned. Please review and complete the following documents:</p>
${list}
<p>The documents are attached to this email. Reach out to your HR contact with any questions.</p>`,
    };
  },
};

export function renderEmail(templateAlias: string, model: EmailModel): RenderedEmail {
  const t = TEMPLATES[templateAlias];
  return t ? t(model) : { subject: `Instant Teams — ${templateAlias}`, html: `<p>${escapeHtml(templateAlias)}</p>` };
}
