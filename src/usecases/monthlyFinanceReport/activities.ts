/**
 * UC4 module-owned activities — build the report sink from env, expose it as one proxied activity.
 * @lifespan PRODUCTION
 * @responsibility Build SheetsReportSink ONCE from loadEnv() inside this module's own activities.ts —
 *   never injected from the host, never built elsewhere (demo → simulator baseUrl, live → the real Sheets
 *   API — PLATFORM_MODE is the only live-ness switch, mirroring startingSoonScan/activities.ts). Sheets I/O
 *   runs here, never in the workflow sandbox. Activity name `writeFinanceReport` is globally unique.
 *   XlsxReportSink is a separate THROWAWAY demo-report generator and is never imported here — a THROWAWAY
 *   file may never be imported by prod-VM code.
 */
import type { FinanceReportRow } from "../../platform/domain/types.js";
import { loadEnv } from "../../platform/config/env.js";
import { SheetsReportSink, loadSheetsConfig } from "./connectors/sheetsReportSink.js";

const reportSink = new SheetsReportSink(loadSheetsConfig(loadEnv()));

export async function writeFinanceReport(name: string, rows: FinanceReportRow[]): Promise<{ location: string }> {
  return reportSink.write(name, rows, (r) => r.isTransition);
}
