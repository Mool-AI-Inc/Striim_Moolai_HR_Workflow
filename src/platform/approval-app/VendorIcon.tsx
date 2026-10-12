/** @lifespan PRODUCTION — the real vendor mark shown beside every option in the stack picker.
 *
 * These are the actual brand logos, served from public/vendor-logos/ and referenced by
 * path, so nothing is fetched from a third party at runtime:
 *   - .svg  from Simple Icons (icon paths are CC0), recoloured to each brand's hex
 *   - .png  the vendor's own favicon at 128px, for brands Simple Icons does not carry
 *
 * The logos are trademarks of their owners and appear here to identify the integration
 * each row configures — the ordinary nominative use an integrations picker makes of them.
 *
 * A vendor with no file falls back to an initial on a neutral tile. That is deliberate:
 * an honest placeholder beats a wrong logo, and the vendor name is always rendered as
 * text beside the mark, so nothing here carries meaning on its own.
 */

/** Option label -> file in public/vendor-logos. */
const LOGOS: Record<string, string> = {
  // HRIS / payroll
  "Paylocity":              "paylocity.png",
  "Workday":                "workday.png",
  "Rippling":               "rippling.png",
  "BambooHR":               "bamboohr.png",
  // Transactional email
  "Postmark":               "postmarkapp.png",
  "Microsoft 365 (Graph)":  "microsoftoffice.svg",
  "SendGrid":               "sendgrid.svg",
  // SMS
  "ActiveCampaign":         "activecampaign.png",
  "Twilio":                 "twilio.svg",
  "Vonage":                 "vonage.svg",
  // Team chat
  "Slack":                  "slack.svg",
  "Microsoft Teams":        "microsoftteams.svg",
  // Background screening
  "Vetty":                  "vetty.png",
  "Checkr":                 "checkr.png",
  "Sterling":               "sterlingcheck.png",
  // Onboarding documents
  "WorkBright":             "workbright.png",
  "DocuSign":               "docusign.svg",
  "Dropbox Sign":           "dropbox.svg",
  // Benefits administration
  "Employee Navigator":     "employeenavigator.png",
  "bswift":                 "bswift.png",
  "Ease":                   "ease.png",
  // Document storage
  "Google Drive":           "googledrive.svg",
  "SharePoint":             "microsoftsharepoint.svg",
  "Box":                    "box.svg",
  // Reporting
  "Google Sheets":          "googlesheets.svg",
  "Excel Online":           "microsoftexcel.svg",
  // RPA
  "Playwright":             "playwright.svg",
  "UiPath":                 "uipath.svg",
  "Power Automate":         "powerautomate.png",
  // AI
  "Claude (Anthropic)":     "claude.svg",
};

export function VendorIcon({ vendor, size = 22 }: { vendor: string; size?: number }) {
  const file = LOGOS[vendor];

  if (!file) {
    // No logo on file — an initial, not an invented mark.
    return (
      <span
        className="vendor-icon vendor-icon-fallback"
        style={{ width: size, height: size, fontSize: size * 0.5 }}
        aria-hidden="true"
      >
        {vendor.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className="vendor-icon"
      src={`/vendor-logos/${file}`}
      width={size}
      height={size}
      alt=""                 /* decorative: the vendor name is text beside it */
      aria-hidden="true"
      loading="lazy"
      decoding="async"
    />
  );
}

/** True when a real logo file backs this vendor. */
export function hasVendorMark(vendor: string): boolean {
  return vendor in LOGOS;
}
