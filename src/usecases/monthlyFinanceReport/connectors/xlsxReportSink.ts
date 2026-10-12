/**
 * Xlsx report sink — a demo stand-in for Google Sheets: writes an .xlsx workbook via exceljs.
 * @lifespan THROWAWAY — demo-only sink; may never be imported by prod-VM code (never referenced from this
 *   module's activities.ts — see the note there). The prod path is SheetsReportSink.
 * @responsibility Implement ReportSink: header row driven by ws.columns, a solid fill on isHighlighted rows
 *   via row.eachCell, plus a legend row explaining the highlight.
 *   # ponytail: exceljs 4.4.0 is stable-but-inactive — fine for the demo sink; prod path is SheetsReportSink.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Workbook } from "exceljs";
import type { Fill } from "exceljs";
import type { ReportSink } from "../../../platform/connectors/types.js";
import type { FinanceReportRow } from "../../../platform/domain/types.js";

const TRANSITION_FILL: Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3B0" } };

export class XlsxReportSink implements ReportSink {
  constructor(private readonly outDir: string) {}

  async write(name: string, rows: FinanceReportRow[], isHighlighted: (r: FinanceReportRow) => boolean): Promise<{ location: string }> {
    const wb = new Workbook();
    const ws = wb.addWorksheet(name);
    ws.columns = [
      { header: "Employee ID", key: "employeeId", width: 14 },
      { header: "Name", key: "name", width: 24 },
      { header: "Cost Center", key: "costCenter", width: 16 },
      { header: "Prior Cost Center", key: "priorCostCenter", width: 18 },
      { header: "Hire Date", key: "hireDate", width: 14 },
    ];

    for (const row of rows) {
      const added = ws.addRow(row);
      if (isHighlighted(row)) added.eachCell((cell) => { cell.fill = TRANSITION_FILL; });
    }

    const legend = ws.addRow({ employeeId: "Highlighted rows = cost-center transition this period" });
    legend.getCell("employeeId").font = { italic: true };

    mkdirSync(this.outDir, { recursive: true });
    const location = join(this.outDir, `${name}.xlsx`);
    await wb.xlsx.writeFile(location);
    return { location };
  }
}
