/**
 * The orchestrator: BambooHR -> Striim -> PostgreSQL -> Workday.
 * @lifespan PRODUCTION — the only place that advances a record through the stages.
 * @responsibility Sequence the stages, record state, guarantee idempotency, expose a snapshot.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. The create call does not push the record downstream. `createEmployee` writes to the source
 *    system and returns. It does not touch the landing table, the intermediate table, or Workday.
 *    Everything after the source is driven by the integration layer NOTICING the change. That is
 *    the difference between demonstrating a pipeline and animating one, and it is why the create
 *    endpoint returns in milliseconds while the dashboard keeps moving afterwards.
 *
 * 2. Every stage is idempotent and claims its work first. At-least-once delivery is not an edge
 *    case in a polling pipeline, it is the normal case: the watermark advances after the landing
 *    write, so a crash in between re-reads the change. Re-running a stage must be a no-op, not a
 *    duplicate.
 */
import {
  appendEvent, claimStep, getEmployee, getLanding, listEmployees, recentEvents, releaseStep,
  setEmployeeSyncStatus, setStage, stagesFor, allStages, upsertEmployee, employeeCount,
  latestEmployee, landingCount, eventCount, ping, resetDemo, bootstrapSkipExisting,
  type EmployeeInput, type Stage, type StageStatus,
} from "./db.js";
import { bus } from "./bus.js";
import { faults, StageFailure, type IntegrationLayer, type SourceSystem, type TargetSystem } from "./adapters/types.js";
import { makeSource } from "./adapters/bamboohr.js";
import { makeIntegration } from "./adapters/striim.js";
import { makeTarget } from "./adapters/workday.js";
import { publicConfig, type SyncDemoConfig } from "./config.js";
import { mappingFor, slotMonitor } from "./slots.js";

const EMP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}

/** Reject at the edge rather than letting a bad row reach three systems and half-fail. */
export function validate(input: Partial<EmployeeInput>): EmployeeInput {
  const need = (field: keyof EmployeeInput, label: string): string => {
    const v = (input[field] ?? "").toString().trim();
    if (!v) throw new ValidationError(`${label} is required`);
    return v;
  };
  const employeeId = need("employeeId", "Employee ID");
  if (!EMP_ID.test(employeeId)) {
    throw new ValidationError("Employee ID must be 2-64 characters of letters, digits, dot, dash or underscore");
  }
  const email = need("email", "Email");
  if (!EMAIL.test(email)) throw new ValidationError(`"${email}" is not a valid email address`);
  const hireDate = (input.hireDate ?? "").toString().trim();
  if (hireDate && !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) {
    throw new ValidationError("Hire date must be YYYY-MM-DD");
  }
  // Pay is what actually reaches Adaptive, so a malformed figure has to be caught here
  // rather than becoming a NaN in an import row.
  const rawPay = (input as { payRate?: unknown }).payRate;
  let payRate: number | undefined;
  if (rawPay !== undefined && rawPay !== null && String(rawPay).trim() !== "") {
    const n = Number(String(rawPay).replace(/[, ]/g, ""));
    if (!Number.isFinite(n) || n < 0) throw new ValidationError(`"${String(rawPay)}" is not a valid pay rate`);
    payRate = n;
  }
  const opt = (v: string | undefined): string | undefined => {
    const t = (v ?? "").trim();
    return t === "" ? undefined : t;
  };
  return {
    employeeId,
    firstName: need("firstName", "First name"),
    lastName: need("lastName", "Last name"),
    email: email.toLowerCase(),
    ...(opt(input.jobTitle) ? { jobTitle: opt(input.jobTitle) } : {}),
    ...(opt(input.department) ? { department: opt(input.department) } : {}),
    ...(opt(input.location) ? { location: opt(input.location) } : {}),
    ...(opt(input.phone) ? { phone: opt(input.phone) } : {}),
    ...(hireDate ? { hireDate } : {}),
    ...(payRate === undefined ? {} : { payRate }),
  };
}

export class Pipeline {
  readonly source: SourceSystem;
  readonly integration: IntegrationLayer;
  readonly target: TargetSystem;

  constructor(private readonly cfg: SyncDemoConfig) {
    this.source = makeSource(cfg);
    this.target = makeTarget(cfg);
    // The integration layer calls back into the pipeline when a row lands. Constructor injection
    // rather than the pipeline polling it, so there is exactly one path downstream.
    this.integration = makeIntegration(cfg, (e, revision) => this.onLanded(e, revision));
  }

  async start(): Promise<void> { await this.integration.start(); }
  async stop(): Promise<void> { await this.integration.stop(); }

  private async mark(employeeId: string, stage: Stage, status: StageStatus, detail?: string, bumpAttempt = false): Promise<void> {
    await setStage(employeeId, stage, status, detail, bumpAttempt);
    bus.publish({ type: "stage", employeeId, stage, status, ...(detail ? { detail } : {}) });
  }

  private async log(message: string, employeeId?: string, stage?: Stage, level: "info" | "success" | "warn" | "error" = "info"): Promise<void> {
    const row = await appendEvent(message, {
      ...(employeeId ? { employeeId } : {}),
      ...(stage ? { stage } : {}),
      level,
    });
    bus.publish({ type: "event", event: row });
  }

  // ── stage 1: the source ─────────────────────────────────────────────────────────────────

  /**
   * Create the employee in BambooHR. Returns as soon as the source has it.
   *
   * Note what is absent: no call to the landing table, no upsert into syncdemo.employees, no
   * Workday call, and no nudge to the poller. The next three stages happen because the
   * integration layer finds the change by itself.
   */
  async createEmployee(raw: Partial<EmployeeInput>): Promise<{ employeeId: string; created: boolean }> {
    const input = validate(raw);

    // All four stages exist as 'pending' before anything is attempted, so the dashboard shows a
    // full pipeline from the first frame rather than rows appearing one at a time.
    for (const stage of ["bamboohr", "striim", "postgres", "workday"] as Stage[]) {
      await this.mark(input.employeeId, stage, "pending");
    }
    await this.mark(input.employeeId, "bamboohr", "processing", "creating in the source system");
    await this.log(`Creating employee ${input.employeeId} in ${this.source.name}`, input.employeeId, "bamboohr");

    try {
      const { sourceId, created } = await this.source.createEmployee(input);
      const detail = created
        ? `created in ${this.source.name} as ${sourceId}`
        : `already existed in ${this.source.name} as ${sourceId} — not duplicated`;
      await this.mark(input.employeeId, "bamboohr", "synced", detail);
      await this.log(
        `Employee ${input.employeeId} ${created ? "created" : "matched (idempotent, no duplicate)"} in BambooHR`,
        input.employeeId, "bamboohr", "success");
      bus.publish({ type: "employee", employeeId: input.employeeId });
      bus.publish({ type: "systems" });
      return { employeeId: input.employeeId, created };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.mark(input.employeeId, "bamboohr", "failed", msg, true);
      await this.log(`BambooHR create failed for ${input.employeeId}: ${msg}`, input.employeeId, "bamboohr", "error");
      throw e;
    }
  }

  // ── stages 3 and 4: triggered by the integration layer ──────────────────────────────────

  /**
   * Called by the integration layer once a row is in the landing table. Runs the mapping into the
   * intermediate table, then the downstream sync into Workday.
   */
  private async onLanded(e: EmployeeInput, revision: number): Promise<void> {
    await this.mark(e.employeeId, "striim", "synced", "landed in the PostgreSQL landing table");
    const ok = await this.runPostgres(e, revision);
    if (ok) await this.runWorkday(e, revision);
  }

  private async runPostgres(e: EmployeeInput, revision: number): Promise<boolean> {
    if (!await claimStep(e.employeeId, "postgres", revision)) {
      // Already applied. Say so rather than silently skipping — a viewer watching the log should
      // be able to see idempotency working, not just be told it exists.
      await this.log(`PostgreSQL write for ${e.employeeId} already applied (revision ${revision}) — skipped`,
        e.employeeId, "postgres");
      return true;
    }
    await this.mark(e.employeeId, "postgres", "processing", "writing the record");
    try {
      if (faults.postgresDown) {
        throw new StageFailure("could not reach PostgreSQL: connection refused (fault injected)");
      }
      await upsertEmployee(e, "bamboohr");
      await this.mark(e.employeeId, "postgres", "synced", "row committed to syncdemo.employees");
      await this.log(`PostgreSQL INSERT successful for ${e.employeeId}`, e.employeeId, "postgres", "success");
      bus.publish({ type: "employee", employeeId: e.employeeId });
      bus.publish({ type: "systems" });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Release the claim so retry can genuinely run again. A claim that outlives its failure
      // makes a stage permanently unretryable, which is the classic bug in this pattern.
      await releaseStep(e.employeeId, "postgres", revision);
      await this.mark(e.employeeId, "postgres", "failed", msg, true);
      await this.log(`PostgreSQL write failed for ${e.employeeId}: ${msg}`, e.employeeId, "postgres", "error");
      try { await setEmployeeSyncStatus(e.employeeId, "failed"); } catch { /* the row may not exist yet */ }
      bus.publish({ type: "systems" });
      return false;
    }
  }

  private async runWorkday(e: EmployeeInput, revision: number): Promise<boolean> {
    if (!await claimStep(e.employeeId, "workday", revision)) {
      await this.log(`Workday sync for ${e.employeeId} already applied (revision ${revision}) — skipped`,
        e.employeeId, "workday");
      return true;
    }
    await this.mark(e.employeeId, "workday", "processing", `sending to ${this.target.name}`);
    await this.log(`PostgreSQL → Workday synchronization started for ${e.employeeId}`, e.employeeId, "workday");
    await this.log("Searching for an available Workday/Adaptive slot", e.employeeId, "workday");
    try {
      const { targetId, created, detail } = await this.target.sync(e);
      const claim = await mappingFor(e.employeeId);
      if (claim) {
        await this.log(`${claim.slot} claimed for ${e.employeeId}`, e.employeeId, "workday");
        await this.log(
          `Employee data written to ${claim.slot}`, e.employeeId, "workday", "success");
      }
      await this.mark(e.employeeId, "workday", "synced", detail);
      await this.log(
        `Workday employee record ${created ? "created" : "updated"} for ${e.employeeId} (${targetId})`,
        e.employeeId, "workday", "success");
      await setEmployeeSyncStatus(e.employeeId, "synced");
      await this.log(`${e.employeeId} synchronization completed across all systems`, e.employeeId, undefined, "success");
      bus.publish({ type: "employee", employeeId: e.employeeId });
      bus.publish({ type: "systems" });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await releaseStep(e.employeeId, "workday", revision);
      await this.mark(e.employeeId, "workday", "failed", msg, true);
      await this.log(`Workday synchronization failed for ${e.employeeId}: ${msg}`, e.employeeId, "workday", "error");
      await setEmployeeSyncStatus(e.employeeId, "failed");
      bus.publish({ type: "systems" });
      return false;
    }
  }

  // ── retry ───────────────────────────────────────────────────────────────────────────────

  /**
   * Re-run whatever failed for one employee, from the earliest failed stage onwards.
   *
   * Uses the landing row as the source of truth rather than re-reading BambooHR: the record has
   * already passed through the transform, and re-deriving it could produce a subtly different
   * shape than the one that failed, which would make the retry a different operation.
   */
  async retry(employeeId: string): Promise<{ retried: Stage[]; ok: boolean }> {
    const stages = await stagesFor(employeeId);
    const failed = stages.filter((s) => s.status === "failed").map((s) => s.stage);
    if (failed.length === 0) return { retried: [], ok: true };

    await this.log(`Retrying ${employeeId}: ${failed.join(", ")}`, employeeId, undefined, "warn");

    // A failure before the landing table means there is nothing to replay downstream; ask the
    // integration layer to look again instead.
    const landed = await getLanding(employeeId);
    if (!landed) {
      await this.integration.pollNow();
      return { retried: failed, ok: true };
    }

    let ok = true;
    if (failed.includes("postgres")) {
      ok = await this.runPostgres(landed.payload, landed.revision);
    }
    if (ok && (failed.includes("workday") || failed.includes("postgres"))) {
      ok = await this.runWorkday(landed.payload, landed.revision);
    }
    return { retried: failed, ok };
  }

  // ── read model for the dashboard ────────────────────────────────────────────────────────

  async snapshot() {
    const [
      employees, stages, events, pgUp, pgCount, pgLatest, landed, eventsTotal,
      sourceCount, sourceHealth, integrationStatus, integrationHealth,
      targetCount, targetLatest, targetHealth,
    ] = await Promise.all([
      listEmployees(50), allStages(), recentEvents(80), ping(), employeeCount(), latestEmployee(),
      landingCount(), eventCount(),
      this.source.count().catch(() => -1), this.source.health().catch((e: Error) => ({ ok: false, detail: e.message })),
      this.integration.status(), this.integration.health().catch((e: Error) => ({ ok: false, detail: e.message })),
      this.target.count().catch(() => -1), this.target.latest().catch(() => undefined),
      this.target.health().catch((e: Error) => ({ ok: false, detail: e.message })),
    ]);

    const latestSource = employees[0];
    const pub = publicConfig(this.cfg);
    // The slot pool and every claim, so the Slot Monitor renders database state rather than
    // anything the browser remembers.
    const slots = await slotMonitor();

    return {
      config: pub,
      faults: { ...faults },
      systems: {
        bamboohr: {
          name: this.source.name, mode: this.source.mode,
          count: sourceCount, health: sourceHealth,
          latest: latestSource ? `${latestSource.employeeId} · ${latestSource.firstName} ${latestSource.lastName}` : undefined,
          lastEvent: events.filter((x) => x.stage === "bamboohr").at(-1)?.message,
        },
        striim: {
          name: this.integration.name, mode: this.integration.mode,
          health: integrationHealth, ...integrationStatus,
          landed,
        },
        postgres: {
          name: "PostgreSQL", mode: "live" as const,
          count: pgCount,
          health: { ok: pgUp, detail: pgUp ? pub.systems.postgres.target : "unreachable" },
          latest: pgLatest ? `${pgLatest.employeeId} · ${pgLatest.firstName} ${pgLatest.lastName}` : undefined,
          lastUpdate: pgLatest?.updatedAt,
          eventsTotal,
        },
        workday: {
          name: this.target.name, mode: this.target.mode,
          count: targetCount, health: targetHealth,
          latest: targetLatest?.label, lastSync: targetLatest?.at,
        },
      },
      slots,
      employees: employees.map((e) => ({ ...e, stages: stages[e.employeeId] ?? [] })),
      // Employees that exist in the source but have not reached the intermediate table yet still
      // need a row in the UI, or the pipeline visual has nothing to show while Striim is working.
      pendingStages: Object.entries(stages)
        .filter(([id]) => !employees.some((e) => e.employeeId === id))
        .map(([employeeId, s]) => ({ employeeId, stages: s })),
      events,
    };
  }

  async reset(): Promise<void> {
    await resetDemo();
    // Immediately, not on the next start. resetDemo() clears bootstrap_skip, so without this the
    // very next poll would treat the whole existing workforce as new hires and replay all 90
    // downstream — the exact thing the baseline exists to prevent, re-armed by pressing Reset.
    const skipped = await bootstrapSkipExisting();
    bus.publish({ type: "reset" });
    await this.log(
      skipped > 0
        ? `Demo reset — every system cleared, and ${skipped} pre-existing employees re-baselined`
        : "Demo reset — every system cleared",
      undefined, undefined, "warn");
    bus.publish({ type: "systems" });
  }
}
