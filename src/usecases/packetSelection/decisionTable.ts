/**
 * UC6 onboarding-packet policy — the decision table + the oracle the LLM is graded against.
 * @lifespan PRODUCTION — the encoded packet policy; pure + deterministic; also the recommender's scorer.
 * @responsibility Map (employeeType × costCenter) to a composed packet; expose the deterministic oracle + guard flags.
 */
import type { EmployeeRecord, OnboardingPacket } from "../../platform/domain/types.js";

// Every US hire signs these, regardless of type or department (federal/tax + core policy + legal). Base-tier docs
// below add the benefits/handbook/tenure layer; the department overlay adds the role-specific layer.
const UNIVERSAL = [
  "offer-letter-ack", "I-9", "W-4", "state-tax-withholding", "direct-deposit",
  "emergency-contact", "code-of-conduct", "anti-harassment-ack", "confidentiality-agreement",
];
const BASE: Record<EmployeeRecord["employeeType"], { label: string; docs: string[] }> = {
  RFT: { label: "Regular Full-Time", docs: ["benefits-enrollment", "handbook-full", "pto-policy"] },
  RPT: { label: "Regular Part-Time", docs: ["limited-benefits-notice", "handbook-core"] },
  SNL: { label: "Seasonal",          docs: ["handbook-seasonal", "end-date-ack"] },
};
const OVERLAY: Record<string, string[]> = {
  "CC-ENG":    ["ip-assignment", "acceptable-use-policy", "equipment-agreement"],
  "CC-RETAIL": ["safety-training", "dress-code", "cash-handling-ack"],
  "CC-CX":     ["customer-data-privacy-ack", "call-monitoring-consent"],
  "CC-OPS":    ["ops-sop-ack", "safety-basics"],
};

export function packetFor(e: Pick<EmployeeRecord, "employeeType" | "costCenter">): OnboardingPacket {
  const base = BASE[e.employeeType];
  const overlay = OVERLAY[e.costCenter] ?? [];
  const dept = e.costCenter.replace(/^CC-/, "");
  return { packetId: `PKT-${e.employeeType}-${dept}`, label: `${base.label} · ${dept}`, baseTier: e.employeeType, overlay: e.costCenter, requiredDocs: [...UNIVERSAL, ...base.docs, ...overlay] };
}

export const expectedPacketId = (e: Pick<EmployeeRecord, "employeeType" | "costCenter">): string => packetFor(e).packetId;

/** Every canonical packet (employeeType × costCenter) — the committed library is derived from this. */
export const ALL_PACKETS: OnboardingPacket[] = (["RFT", "RPT", "SNL"] as const).flatMap((t) =>
  Object.keys(OVERLAY).map((cc) => packetFor({ employeeType: t, costCenter: cc })));

/** Non-blocking policy flags the recommender should surface (the "AI tail"); never change the packet id. */
export function guards(e: Pick<EmployeeRecord, "employeeType" | "costCenter" | "status">): string[] {
  const f: string[] = [];
  if (e.status !== "A") f.push(`status ${e.status} — not active; confirm before assigning`);
  if (e.employeeType === "SNL" && e.costCenter === "CC-ENG") f.push("uncommon SNL×ENG combination — verify department");
  return f;
}
