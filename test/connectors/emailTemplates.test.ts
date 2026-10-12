import { describe, it, expect } from "vitest";
import { renderEmail } from "../../src/platform/connectors/comms/emailTemplates.js";

describe("email templates", () => {
  it("renders the welcome email with the employee's name in subject + body", () => {
    const { subject, html } = renderEmail("welcome", { firstName: "Dana" });
    expect(subject).toContain("Dana");
    expect(html).toContain("Dana");
  });

  it("renders the Day-60 compliance and welcome-SMS-as-email aliases", () => {
    expect(renderEmail("day60-compliance", { firstName: "Dana" }).subject).toMatch(/compliance/i);
    expect(renderEmail("welcome-sms", { firstName: "Dana" }).html).toMatch(/welcome/i);
  });

  it("escapes HTML in the body to prevent injection via a name", () => {
    const { html } = renderEmail("welcome", { firstName: "<script>x</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back for an unknown alias without throwing", () => {
    const { subject } = renderEmail("mystery-alias", {});
    expect(subject).toContain("mystery-alias");
  });
});
