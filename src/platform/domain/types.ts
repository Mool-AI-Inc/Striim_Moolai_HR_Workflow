/**
 * Domain types + template registry — the contract every layer speaks.
 * @lifespan PRODUCTION — permanent; connectors, workflows, ledger, approval spine, and every module import these.
 * @responsibility Define EmployeeRecord, message/receipt shapes, template aliases, approval + packet shapes.
 */
export interface EmployeeRecord {
  employeeId: string; firstName: string; lastName: string; email: string;
  birthDate: string;  // YYYY-MM-DD
  hireDate: string;   // YYYY-MM-DD — benefits-eligibility anchor; also UC8 reads it as the start date
  employeeType: "RFT" | "RPT" | "SNL";
  status: "A" | "L" | "T";
  costCenter: string;                 // CC-RETAIL | CC-OPS | CC-CX | CC-ENG (UC6 keys off this)
  phone: string;
  smsConsent: boolean;
  priorCostCenter?: string;           // present + differing ⇒ an account transition (UC4)
}
export interface NewHireEvent { employeeId: string; companyId: string; eventId: string; }
export interface TransactionalEmail { to: string; templateAlias: TemplateAlias; model: Record<string, string>; idempotencyKey: string; }
export interface SendReceipt { messageId: string; submittedAt: string; }
export const TEMPLATE = {
  WELCOME: "welcome", DAY60_COMPLIANCE: "day60-compliance", BIRTHDAY: "birthday", ANNIVERSARY: "anniversary",
  WELCOME_SMS: "welcome-sms", UC4_REPORT_READY: "uc4-report-ready", ONBOARDING_PACKET: "onboarding-packet",
} as const;
export type TemplateAlias = (typeof TEMPLATE)[keyof typeof TEMPLATE];

export interface SmsMessage { to: string; body: string; idempotencyKey: string; }
export interface SlackInvite { email: string; channelIds: string[]; kind: "member" | "guest"; }
export interface ScreeningDoc { filename: string; contentType: string; bytes: Uint8Array; }
export interface FinanceReportRow { employeeId: string; name: string; costCenter: string; priorCostCenter?: string; hireDate: string; isTransition: boolean; }
export interface PersonnelChecklist { employeeId: string; arrived: string[]; missing: string[]; }
export interface ApprovalDecision { approved: boolean; reason: string; approver: string; selectedDocs?: string[]; } // UC6: the subset of packet docs the reviewer chose to assign + email
export interface PendingApproval {
  id: string; workflowId: string;
  kind: "personnel-file" | "finance-report" | "packet-assignment" | "benefits-send";
  title: string; detail: unknown; createdAt: string;
  status: "pending" | "approved" | "rejected" | "expired";
}
export interface OnboardingPacket { packetId: string; label: string; baseTier: EmployeeRecord["employeeType"]; overlay: string; requiredDocs: string[]; }
export interface PacketRecommendation { packetId: string; rationale: string; confidence: number; flags: string[]; }
/** UC6 approval detail: the recommendation + the packet's contents + the employee context the reviewer needs to confirm. */
export interface PacketApprovalDetail extends PacketRecommendation {
  label: string; requiredDocs: string[];
  employeeType: EmployeeRecord["employeeType"]; costCenter: string; status: EmployeeRecord["status"];
}
