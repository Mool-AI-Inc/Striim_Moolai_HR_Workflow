/**
 * Connector-port catalog — the shared contract catalog: the boundary between orchestration and any SaaS.
 * @lifespan PRODUCTION — permanent; shared connectors, per-module impls, fakes, and activities implement/consume these.
 * @responsibility Declare every read/send/screening/report/packet capability the workflows depend on, plus the ConnectorRegistry bag.
 */
import type {
  EmployeeRecord, TransactionalEmail, SendReceipt, SmsMessage, SlackInvite, ScreeningDoc,
  FinanceReportRow, PacketRecommendation,
} from "../domain/types.js";

export interface HrisReadConnector {
  getEmployee(companyId: string, employeeId: string): Promise<EmployeeRecord>;
  listEmployees(companyId: string): Promise<EmployeeRecord[]>;
}
export interface CommsConnector { sendTransactional(email: TransactionalEmail): Promise<SendReceipt>; }
export interface SmsConnector { sendSms(msg: SmsMessage): Promise<{ messageId: string }>; }
export interface SlackAdminConnector { invite(inv: SlackInvite): Promise<{ invited: boolean; alreadyMember: boolean }>; }
export interface ScreeningConnector { getScreening(id: string): Promise<ScreeningDoc>; }           // Vetty
export interface OnboardingDocsConnector { getSubmissionFile(id: string): Promise<ScreeningDoc>; }  // WorkBright
export interface DriveConnector { putFile(folderId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ fileId: string }>; } // putFile ONLY — by design
export interface ReportSink { write(name: string, rows: FinanceReportRow[], isHighlighted: (r: FinanceReportRow) => boolean): Promise<{ location: string }>; }
export interface PacketConnector { assignPacket(employeeId: string, packetId: string, docs: string[]): Promise<{ receiptId: string }> } // prod impl = RPA runner; docs = the reviewer-approved subset
export interface EmployeeNavigatorConnector { stageSend(employeeId: string): Promise<{ receiptId: string }> }           // prod impl = RPA runner
export interface PacketRecommender { recommend(employee: EmployeeRecord): Promise<PacketRecommendation>; }

/** The connector bag the host injects into HostCtx.connectors. Declared here (not in registry.ts) so the
 *  Task-9 host contract references it without a forward import; the concrete instance is built in Task 12.
 *  NARROWED to the two PLATFORM-owned connectors the host uses centrally: `hris` (Paylocity — the shared
 *  getEmployee/listEmployees activities) and `comms` (Postmark — the
 *  shared sendEmail activity). Every OTHER port in this catalog is MODULE-owned: its impl lives under
 *  usecases/<module>/ and is constructed from env INSIDE that module's own activities.ts (Temporal registers
 *  activities as pre-built functions in the manifest — they are never handed a HostCtx), so it is never
 *  injected here. Keeping those out of the bag is what lets platform/connectors/registry.ts avoid importing
 *  usecases/* — the isolation rule holds with no whitelist for the connector registry. (PacketRecommender is
 *  likewise not a member: the packetSelection recommendPacket activity picks Rule-vs-Llm from ANTHROPIC_API_KEY.) */
export interface ConnectorRegistry {
  hris: HrisReadConnector;   // Paylocity read — the shared getEmployee/listEmployees activities
  comms: CommsConnector;     // Postmark — the shared sendEmail activity
}
