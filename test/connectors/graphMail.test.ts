import { describe, it, expect } from "vitest";
import { GraphMailer, buildFileAttachment, AttachmentTooLargeError } from "../../src/platform/connectors/comms/graphMail.js";

const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", senderEmail: "platform@moolai.ai" };

describe("GraphMailer.wrapReportBody", () => {
  it("wraps the body in the branded shell + a do-not-reply footer", () => {
    const out = new GraphMailer(cfg).wrapReportBody("<h1>Hi</h1>");
    expect(out).toContain("MoolAI");
    expect(out).toMatch(/do not reply/i);
  });

  it("inserts the caller body VERBATIM (trusted — not re-escaped)", () => {
    const out = new GraphMailer(cfg).wrapReportBody("<a href='x'>link</a>");
    expect(out).toContain("<a href='x'>link</a>");
  });

  it("uses a configurable platform name in the shell", () => {
    const out = new GraphMailer({ ...cfg, platformName: "Acme" }).wrapReportBody("body");
    expect(out).toContain("Acme");
  });
});

describe("buildFileAttachment", () => {
  it("builds a base64 Graph fileAttachment with a content type guessed from the extension", () => {
    const att = buildFileAttachment({ filename: "benefits-summary.pdf", content: new Uint8Array([1, 2, 3]) });
    expect(att["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
    expect(att.name).toBe("benefits-summary.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(att.contentBytes).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("rejects an attachment over the 3 MB inline ceiling", () => {
    const tooBig = { filename: "big.pdf", content: new Uint8Array(3 * 1024 * 1024 + 1) };
    expect(() => buildFileAttachment(tooBig)).toThrow(AttachmentTooLargeError);
  });
});
