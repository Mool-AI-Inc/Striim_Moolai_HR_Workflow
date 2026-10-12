/**
 * In-memory report sink fake — Layer-B scaffolding the UC4 workflow test injects.
 * @lifespan THROWAWAY — lives under src/ but is never imported by a prod entrypoint; a test double only.
 * @responsibility Mimic ReportSink.write: record every call's full row set plus which rows the caller's
 *   isHighlighted predicate flagged, and return a deterministic location.
 */
import type { ReportSink } from "../../../platform/connectors/types.js";
import type { FinanceReportRow } from "../../../platform/domain/types.js";

export interface RecordedWrite { name: string; rows: FinanceReportRow[]; highlighted: FinanceReportRow[]; }

export class InMemoryReportSink implements ReportSink {
  readonly writes: RecordedWrite[] = [];

  async write(name: string, rows: FinanceReportRow[], isHighlighted: (r: FinanceReportRow) => boolean): Promise<{ location: string }> {
    const highlighted = rows.filter(isHighlighted);
    this.writes.push({ name, rows, highlighted });
    return { location: `mem://${name}` };
  }
}
