/**
 * Workday/Adaptive target adapter — mock and live.
 * @lifespan PRODUCTION — the downstream half of the pipeline.
 * @responsibility Claim a pre-allocated member, write the employee's REAL data into it, report.
 *
 * WHAT "SYNCHRONISED TO WORKDAY" HONESTLY MEANS HERE
 *
 * Not "a new Workday worker was created". The accurate description, and the one the UI uses, is:
 *
 *   real-time employee data synchronisation from BambooHR through Striim and PostgreSQL into
 *   PRE-ALLOCATED Workday/Adaptive demo members.
 *
 * The reason is a hard property of the platform, verified against the live tenant rather than
 * assumed. Adaptive Planning's modeled-sheet dimensions are ENUMERATED, and the only API methods
 * available with these credentials are exportData, exportSheets and importConfigurableModelData —
 * none of which can create a dimension member. A BambooHR id is refused outright:
 *
 *   "dimension values for EmpID_EUPTD are either not available for the sheet or do not exist: 104"
 *
 * So an administrator pre-allocates empty members and this adapter claims one per new hire. The
 * employee's data is entirely real and flows end to end; the only pre-made thing is the empty
 * destination. Nothing outside the configured pool is ever written — see slots.ts.
 *
 * THREE DETAILS THAT COST A DAY TO FIND
 *
 *   minimalRow      Level|EmpID_EUPTD|<metric>|<month>. The nine-column form with Gender,
 *                   Location, Job_Group, Job_Classification and Worker_Name is rejected six times
 *                   over, because the EUPTD export carries literal placeholder members for two of
 *                   those dimensions. Four columns writes; nine does not.
 *   level code      "SUPERVISORY_Workforce_Planning_Department", not the display name
 *                   "Workforce Planning Department" — the latter is an "Invalid Level Choice".
 *   metric column   "PY Pay" is the ONLY writable column on this template. Headcount, Salary,
 *                   Taxes, Tenure in Months and Total Compensation each return
 *                   "Invalid header name(s)". So the payload is a pay figure, and there is no
 *                   harmless placeholder value.
 */
import { AdaptiveClient } from "../../../platform/hris/adaptiveClient.js";
import type { SyncDemoConfig } from "../config.js";
import {
  mockWorkdayCount, mockWorkdayGet, mockWorkdayLatest, mockWorkdayUpsert,
  recordWorkdaySync, workdaySyncedCount, workdaySyncedLatest, type EmployeeInput,
} from "../db.js";
import { claimSlot, setMappingStatus, type Mapping } from "../slots.js";
import { faults, StageFailure, type HealthReport, type TargetSystem } from "./types.js";

/** What both implementations do first, so the allocator is exercised in either mode. */
async function claimFor(e: EmployeeInput): Promise<{ mapping: Mapping; fresh: boolean }> {
  const name = `${e.firstName} ${e.lastName}`.trim();
  try {
    return await claimSlot(e.employeeId, name);
  } catch (err) {
    // NoSlotsAvailable carries the operator-facing sentence. Not retryable: the pool does not
    // refill on its own, and retrying forever would hide the one thing someone has to act on.
    throw new StageFailure(err instanceof Error ? err.message : String(err), false);
  }
}

export class MockWorkday implements TargetSystem {
  readonly name = "Workday (mock)";
  readonly mode = "mock" as const;

  async sync(e: EmployeeInput): Promise<{ targetId: string; created: boolean; detail: string }> {
    // Claimed BEFORE the fault check, deliberately. A failure after the claim is the realistic
    // case — the slot is reserved and the write failed — and it is what makes retry reuse the
    // same member instead of consuming a second one.
    const { mapping, fresh } = await claimFor(e);

    if (faults.workdayFail) {
      await setMappingStatus(e.employeeId, "FAILED", "Workday returned 503 (fault injected)");
      throw new StageFailure("Workday returned 503 Service Unavailable (fault injected)");
    }

    await setMappingStatus(e.employeeId, "SYNCING", `writing into ${mapping.slot}`);
    const existing = await mockWorkdayGet(e.employeeId);
    const workerId = (existing?.worker_id as string) ?? mapping.slot;
    const { created } = await mockWorkdayUpsert(e, workerId);
    await setMappingStatus(e.employeeId, "SYNCED",
      `${e.firstName} ${e.lastName} written into ${mapping.slot}`);

    return {
      targetId: mapping.slot,
      created,
      detail: `${fresh ? "claimed" : "reused"} slot ${mapping.slot}; `
            + `${created ? "worker record created" : "worker record updated"}`,
    };
  }

  count(): Promise<number> { return mockWorkdayCount(); }

  async latest(): Promise<{ label: string; at: string } | undefined> {
    const row = await mockWorkdayLatest();
    if (!row) return undefined;
    return {
      label: `${row.employee_id} · ${row.legal_name} (${row.worker_id})`,
      at: new Date(row.updated_at as string).toISOString(),
    };
  }

  async health(): Promise<HealthReport> {
    if (faults.workdayFail) return { ok: false, detail: "fault injected — sync will fail" };
    return { ok: true, detail: "in-process mock; slot allocation is the real allocator" };
  }
}

export class LiveWorkday implements TargetSystem {
  readonly name = "Workday Adaptive Planning";
  readonly mode = "live" as const;
  private readonly client: AdaptiveClient;

  constructor(private readonly cfg: SyncDemoConfig["workday"]) {
    this.client = new AdaptiveClient({
      apiUrl: cfg.apiUrl ?? "", tokenUrl: cfg.tokenUrl ?? "", tokenExchangeUrl: cfg.tokenExchangeUrl ?? "",
      clientId: cfg.clientId ?? "", clientSecret: cfg.clientSecret ?? "", refreshToken: cfg.refreshToken ?? "",
      version: cfg.version ?? "default",
      ...(cfg.instanceCode ? { instanceCode: cfg.instanceCode } : {}),
      // The INTERNAL level code. ADAPTIVE_LEVEL holds the display name, which Adaptive rejects.
      level: cfg.levelCode,
      sheetName: cfg.sheetName,
      importKey: cfg.importKey,
      minimalRow: true,
    });
  }

  async sync(e: EmployeeInput): Promise<{ targetId: string; created: boolean; detail: string }> {
    const { mapping, fresh } = await claimFor(e);

    if (faults.workdayFail) {
      await setMappingStatus(e.employeeId, "FAILED", "fault injected before the Adaptive write");
      throw new StageFailure("fault injected before the live Adaptive write");
    }

    // No pay figure, no write. "PY Pay" is the only writable column, so the alternative is putting
    // a zero into a real pay cell — in a model a pay-equity agent reads from. The slot stays
    // claimed so adding the figure in BambooHR and retrying lands in the same member.
    if (e.payRate === undefined || !Number.isFinite(e.payRate)) {
      const why = `no pay figure for ${e.employeeId}. "${this.cfg.metricColumn}" is the only `
                + `writable column on "${this.cfg.sheetName}", and writing 0 would overwrite a `
                + "real pay value. Set a pay rate in BambooHR and retry.";
      await setMappingStatus(e.employeeId, "FAILED", why);
      throw new StageFailure(why, false);
    }

    const month = this.cfg.writeMonth
      || new Date().toISOString().slice(0, 7).split("-").reverse().join("/"); // MM/YYYY

    await setMappingStatus(e.employeeId, "SYNCING",
      `importing ${this.cfg.metricColumn} ${e.payRate} into ${mapping.slot} for ${month}`);

    try {
      const res = await this.client.importRows([{
        // The member, not the BambooHR id. The BambooHR id is not a dimension member and never
        // can be; the mapping is what connects them and it is persisted in Postgres.
        employeeId: mapping.slot,
        workerName: `${e.firstName} ${e.lastName}`.trim(),
        month,
        metricColumn: this.cfg.metricColumn,
        value: e.payRate,
      }]);
      if (!res.success) throw new StageFailure(`Adaptive rejected the import: ${res.message}`);

      const detail = `${e.employeeId} -> ${mapping.slot}: ${this.cfg.metricColumn} ${e.payRate} `
                   + `written to "${this.cfg.sheetName}" for ${month}. ${res.message}`;
      await setMappingStatus(e.employeeId, "SYNCED", detail);
      await recordWorkdaySync(e.employeeId, mapping.slot, detail);
      return {
        targetId: mapping.slot,
        // `created: false` is the honest answer — a pre-allocated member was filled, not created.
        created: false,
        detail: `${fresh ? "claimed" : "reused"} slot ${mapping.slot}. ${detail}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await setMappingStatus(e.employeeId, "FAILED", msg);
      if (err instanceof StageFailure) throw err;
      throw new StageFailure(msg);
    }
  }

  /**
   * Employees this pipeline has synchronised, read from Postgres so it survives a restart.
   *
   * Not the sheet's row count: Adaptive has no cheap count call, and the sheet also holds rows
   * written by the Slack agent on the same instance. The card labels it accordingly.
   */
  count(): Promise<number> { return workdaySyncedCount(); }

  latest(): Promise<{ label: string; at: string } | undefined> { return workdaySyncedLatest(); }

  async health(): Promise<HealthReport> {
    try {
      // The two-hop OAuth chain is what breaks, so exercising it is the real check — and it is
      // read-only, which a write-based health check would not be.
      const token = await this.client.authenticate();
      return {
        ok: true,
        detail: `authenticated to ${this.cfg.instanceCode ?? "Adaptive"} `
              + `(token ${token.length} chars) · writes ${this.cfg.metricColumn} into pre-allocated members`,
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function makeTarget(cfg: SyncDemoConfig): TargetSystem {
  return cfg.workday.mode === "live" ? new LiveWorkday(cfg.workday) : new MockWorkday();
}
