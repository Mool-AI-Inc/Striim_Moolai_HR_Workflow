/**
 * Google Sheets report sink — the prod path for the monthly finance report.
 * @lifespan PRODUCTION — the real vendor connector the module's own activities.ts builds from env.
 * @responsibility Implement ReportSink against the Sheets REST API: values.batchUpdate writes the header +
 *   rows, then a batchUpdate repeatCell request applies the solid-fill conditional format to isHighlighted
 *   rows (same visual contract as XlsxReportSink's {type:"pattern",pattern:"solid",fgColor:{argb:"FFFFF3B0"}}
 *   fill, expressed as the Sheets RGB equivalent). Same ReportSink contract as XlsxReportSink — the demo
 *   sink is a THROWAWAY stand-in, never imported here; PLATFORM_MODE governs this connector's baseUrl only
 *   (demo → simulator, live → the real Sheets API), mirroring how startingSoonScan's SlackConnector is built.
 */
import type { ReportSink } from "../../../platform/connectors/types.js";
import type { FinanceReportRow } from "../../../platform/domain/types.js";
import type { Env } from "../../../platform/config/env.js";

export interface SheetsConfig { baseUrl: string; token: string; spreadsheetId: string; }

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name} (PLATFORM_MODE=live)`);
  return v;
}

/** demo → the simulator + a fixed placeholder spreadsheet id; live → SHEETS_* env vars, all required. */
export function loadSheetsConfig(env: Env): SheetsConfig {
  if (env.mode === "demo") return { baseUrl: env.simulatorUrl, token: "demo", spreadsheetId: "demo-finance-report" };
  return { baseUrl: required("SHEETS_BASE_URL"), token: required("SHEETS_TOKEN"), spreadsheetId: required("SHEETS_SPREADSHEET_ID") };
}

const TRANSITION_RGB = { red: 1, green: 0.953, blue: 0.69 }; // FFF3B0 — same highlight color as the xlsx sink

export class SheetsReportSink implements ReportSink {
  constructor(private readonly cfg: SheetsConfig) {}

  async write(name: string, rows: FinanceReportRow[], isHighlighted: (r: FinanceReportRow) => boolean): Promise<{ location: string }> {
    const header = ["Employee ID", "Name", "Cost Center", "Prior Cost Center", "Hire Date"];
    const values = [header, ...rows.map((r) => [r.employeeId, r.name, r.costCenter, r.priorCostCenter ?? "", r.hireDate])];

    await this.post(`/v4/spreadsheets/${this.cfg.spreadsheetId}/values:batchUpdate`, {
      valueInputOption: "RAW",
      data: [{ range: `${name}!A1`, values }],
    });

    const highlightedRowIndexes = rows
      .map((r, i) => (isHighlighted(r) ? i + 1 : -1)) // +1 to skip the header row (Sheets rows are 0-indexed)
      .filter((i) => i >= 0);
    if (highlightedRowIndexes.length > 0) {
      await this.post(`/v4/spreadsheets/${this.cfg.spreadsheetId}:batchUpdate`, {
        requests: highlightedRowIndexes.map((rowIndex) => ({
          repeatCell: {
            range: { sheetId: 0, startRowIndex: rowIndex, endRowIndex: rowIndex + 1 },
            cell: { userEnteredFormat: { backgroundColor: TRANSITION_RGB } },
            fields: "userEnteredFormat.backgroundColor",
          },
        })),
      });
    }

    return { location: `https://docs.google.com/spreadsheets/d/${this.cfg.spreadsheetId}#gid=0&range=${name}` };
  }

  private async post(path: string, body: unknown): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`sheets network error: ${(e as Error).message}`); // retryable
    }
    if (res.status === 429 || res.status >= 500) throw new Error(`sheets retryable ${res.status}`); // 429/5xx → retry
    if (!res.ok) throw new Error(`sheets request failed: ${res.status}`);
  }
}
