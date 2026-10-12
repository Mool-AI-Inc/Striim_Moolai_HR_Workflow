/**
 * Demo onboarding-document generator — render data-aligned PDFs from an EmployeeRecord.
 * @lifespan THROWAWAY — dev/demo/test only; backs the simulator + `npm run demo`. Prod fetches real vendor docs.
 * @responsibility Compose each document's text from the employee (+ their UC6 packet) and render it to a one-page PDF.
 *   Every doc id that can appear in a packet (decisionTable) has a spec here; unknown ids fall back to a generic ack.
 */
import type { EmployeeRecord } from "../src/platform/domain/types.js";
import { packetFor } from "../src/usecases/packetSelection/decisionTable.js";
import PDFDocument from "pdfkit";

// The named docs the platform code references directly; renderDocument/documentLines accept ANY packet doc id (string).
export type DocKind =
  | "background-check" | "I-9" | "benefits-summary"
  | "offer-letter-ack" | "W-4" | "state-tax-withholding" | "direct-deposit" | "emergency-contact"
  | "code-of-conduct" | "anti-harassment-ack" | "confidentiality-agreement"
  | "benefits-enrollment" | "handbook-full" | "pto-policy" | "limited-benefits-notice" | "handbook-core"
  | "handbook-seasonal" | "end-date-ack"
  | "ip-assignment" | "acceptable-use-policy" | "equipment-agreement"
  | "safety-training" | "dress-code" | "cash-handling-ack"
  | "customer-data-privacy-ack" | "call-monitoring-consent" | "ops-sop-ack" | "safety-basics";

const TYPE_LABEL: Record<EmployeeRecord["employeeType"], string> = {
  RFT: "Regular Full-Time", RPT: "Regular Part-Time", SNL: "Seasonal",
};
const PLAN_TIER: Record<EmployeeRecord["employeeType"], string> = {
  RFT: "Full-time benefits", RPT: "Part-time (limited) benefits", SNL: "Seasonal — benefits not applicable",
};

function plus60(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 60);
  return d.toISOString().slice(0, 10);
}

const name = (e: EmployeeRecord): string => `${e.firstName} ${e.lastName}`;
const idLine = (e: EmployeeRecord): string => `Employee: ${name(e)} (ID ${e.employeeId})`;
const sign = (e: EmployeeRecord): string => `Acknowledged by ${name(e)} — signature on file · ${e.hireDate}`;
const titleCase = (kind: string): string => kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** title + body lines per doc id. Each takes the employee so the content is per-hire. */
const SPECS: Record<string, (e: EmployeeRecord) => string[]> = {
  // ── Standalone (screening / benefits — used by welcome + Day-60 mail, not packet members) ──
  "background-check": (e) => [
    "Background Check Report",
    `Candidate: ${name(e)}`,
    `Date of birth: ${e.birthDate}`,
    `Case ID: BGC-${e.employeeId}`,
    "Result: CLEAR",
    "Employer: Instant Teams",
  ],
  "benefits-summary": (e) => [
    "Benefits Summary — Day 60 Eligibility",
    `Employee: ${name(e)}`,
    `Plan tier: ${PLAN_TIER[e.employeeType]}`,
    `Eligibility date: ${plus60(e.hireDate)}`,
    `Cost center: ${e.costCenter}`,
  ],

  // ── Universal (every hire) ──────────────────────────────────────────────
  "offer-letter-ack": (e) => [
    "Offer Letter Acknowledgment",
    idLine(e), `Start date: ${e.hireDate}`, `Employment type: ${TYPE_LABEL[e.employeeType]}`, `Cost center: ${e.costCenter}`,
    "I accept the terms of my offer of employment with Instant Teams.", sign(e),
  ],
  "I-9": (e) => {
    const p = packetFor(e);
    return [
      "Form I-9 — Employment Eligibility Verification",
      `Employee: ${name(e)} (ID ${e.employeeId})`,
      `Date of hire: ${e.hireDate}`,
      `Employment type: ${TYPE_LABEL[e.employeeType]}`,
      `Cost center: ${e.costCenter}`,
      "Section 1: Complete",
      `Assigned onboarding packet: ${p.packetId} — requires ${p.requiredDocs.join(", ")}`,
    ];
  },
  "W-4": (e) => [
    "Form W-4 — Employee's Withholding Certificate",
    idLine(e), `Tax year: ${e.hireDate.slice(0, 4)}`, "Filing status: Single or Married filing separately",
    "Step 1 (personal information): Complete", "Step 5 (signature): Complete", sign(e),
  ],
  "state-tax-withholding": (e) => [
    "State Income Tax Withholding Certificate",
    idLine(e), `Work cost center: ${e.costCenter}`, "Allowances claimed: 1", "Additional withholding: $0.00", sign(e),
  ],
  "direct-deposit": (e) => [
    "Direct Deposit Authorization",
    idLine(e), "Account type: Checking", "Routing number: ****6789", "Account number: ****4321",
    "I authorize Instant Teams to deposit my net pay to this account.", sign(e),
  ],
  "emergency-contact": (e) => [
    "Emergency Contact Information",
    idLine(e), "Primary contact: on file", "Relationship: on file", "Contact phone: on file", sign(e),
  ],
  "code-of-conduct": (e) => [
    "Code of Conduct Acknowledgment",
    idLine(e), "I have read and agree to abide by the Instant Teams Code of Conduct.",
    "Covers ethics, conflicts of interest, and reporting obligations.", sign(e),
  ],
  "anti-harassment-ack": (e) => [
    "Anti-Harassment & Equal Opportunity Policy Acknowledgment",
    idLine(e), "I have reviewed the anti-harassment and equal-opportunity policy.",
    "I understand how to report concerns.", sign(e),
  ],
  "confidentiality-agreement": (e) => [
    "Confidentiality Agreement (NDA)",
    idLine(e), `Effective date: ${e.hireDate}`, "I agree to protect Instant Teams confidential and proprietary information.",
    "These obligations survive termination of employment.", sign(e),
  ],

  // ── Tier (benefits / handbook / tenure) ─────────────────────────────────
  "benefits-enrollment": (e) => [
    "Benefits Enrollment Form",
    idLine(e), `Plan tier: ${PLAN_TIER[e.employeeType]}`, "Medical / Dental / Vision: Elected", "401(k) deferral: 5%",
    `Eligibility date: ${plus60(e.hireDate)}`, sign(e),
  ],
  "handbook-full": (e) => [
    "Employee Handbook Acknowledgment (Full-Time)",
    idLine(e), "I acknowledge receipt of the full Instant Teams Employee Handbook.", sign(e),
  ],
  "pto-policy": (e) => [
    "Paid Time Off Policy Acknowledgment",
    idLine(e), "Accrual: 15 days per year (full-time)", "I have reviewed the PTO and leave policy.", sign(e),
  ],
  "limited-benefits-notice": (e) => [
    "Limited Benefits Notice (Part-Time)",
    idLine(e), `Plan tier: ${PLAN_TIER[e.employeeType]}`, "Eligible for: limited medical + 401(k)", sign(e),
  ],
  "handbook-core": (e) => [
    "Employee Handbook Acknowledgment (Core)",
    idLine(e), "I acknowledge receipt of the core Instant Teams Employee Handbook.", sign(e),
  ],
  "handbook-seasonal": (e) => [
    "Seasonal Worker Handbook Acknowledgment",
    idLine(e), "I acknowledge receipt of the seasonal worker handbook.", sign(e),
  ],
  "end-date-ack": (e) => [
    "Seasonal Assignment End-Date Acknowledgment",
    idLine(e), "Assignment type: Seasonal (fixed term)", "I understand this is a fixed-term seasonal assignment.", sign(e),
  ],

  // ── Department overlay (role-specific) ──────────────────────────────────
  "ip-assignment": (e) => [
    "Intellectual Property Assignment Agreement",
    idLine(e), `Cost center: ${e.costCenter}`, "I assign to Instant Teams all IP created within the scope of my employment.", sign(e),
  ],
  "acceptable-use-policy": (e) => [
    "Acceptable Use Policy (IT)",
    idLine(e), "I agree to use company systems, networks, and data responsibly and securely.", sign(e),
  ],
  "equipment-agreement": (e) => [
    "Company Equipment & Asset Agreement",
    idLine(e), "Issued: laptop, access badge", "I agree to return all company equipment on separation.", sign(e),
  ],
  "safety-training": (e) => [
    "Workplace Safety Training Acknowledgment",
    idLine(e), "Modules: OSHA basics, emergency procedures", `Completed: ${e.hireDate}`, sign(e),
  ],
  "dress-code": (e) => [
    "Dress Code & Appearance Policy Acknowledgment",
    idLine(e), "I have reviewed the store dress-code and appearance standards.", sign(e),
  ],
  "cash-handling-ack": (e) => [
    "Cash Handling Policy Acknowledgment",
    idLine(e), "I have reviewed cash-drawer, till, and deposit procedures.", sign(e),
  ],
  "customer-data-privacy-ack": (e) => [
    "Customer Data Privacy Acknowledgment",
    idLine(e), "I agree to handle customer data per the privacy policy and applicable law.", sign(e),
  ],
  "call-monitoring-consent": (e) => [
    "Call Monitoring & Recording Consent",
    idLine(e), "I consent to the monitoring and recording of customer calls for QA and training.", sign(e),
  ],
  "ops-sop-ack": (e) => [
    "Operations SOP Acknowledgment",
    idLine(e), "I have reviewed the standard operating procedures for my role.", sign(e),
  ],
  "safety-basics": (e) => [
    "Safety Basics Acknowledgment",
    idLine(e), "I have completed basic workplace-safety orientation.", sign(e),
  ],
};

/** Any packet doc id not specced above still renders a plausible one-page acknowledgment. */
function genericDoc(kind: string, e: EmployeeRecord): string[] {
  return [
    `${titleCase(kind)} — Acknowledgment`,
    idLine(e), `Cost center: ${e.costCenter}`,
    "I acknowledge receipt and review of this onboarding document.", sign(e),
  ];
}

export function documentLines(kind: string, e: EmployeeRecord): string[] {
  return (SPECS[kind] ?? ((emp) => genericDoc(kind, emp)))(e);
}

export function renderDocument(kind: string, e: EmployeeRecord): Promise<Uint8Array> {
  const [title, ...body] = documentLines(kind, e);
  return new Promise<Uint8Array>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 64 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    doc.fontSize(18).text(title);
    doc.moveDown().fontSize(12);
    for (const line of body) doc.text(line).moveDown(0.3);
    doc.end();
  });
}
