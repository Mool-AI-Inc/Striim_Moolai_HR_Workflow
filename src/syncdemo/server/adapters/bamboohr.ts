/**
 * BambooHR source adapter — mock and live.
 * @lifespan PRODUCTION — the origin of every employee in this demo.
 * @responsibility Create an employee in the source system, idempotently, and report its health.
 *
 * The live implementation wraps src/platform/hris/bamboohrClient.ts, which already exists in
 * this repo and is the tested write path into a real HRIS: it handles BambooHR's Basic auth with
 * the API key as the username, honours 503 Retry-After, and distinguishes a seat-limit 429 (not
 * retryable, the account is full) from throttling (retryable). There was no reason to write a
 * second BambooHR client.
 */
import { BambooHRClient, SeatLimitReached } from "../../../platform/hris/bamboohrClient.js";
import type { SyncDemoConfig } from "../config.js";
import { mockBambooCount, mockBambooFindByEmail, mockBambooUpsert, type EmployeeInput } from "../db.js";
import type { HealthReport, SourceSystem } from "./types.js";
import { StageFailure } from "./types.js";

/**
 * A local stand-in for BambooHR, backed by its own table.
 *
 * It is a mock in the sense that it is not BambooHR — not in the sense that it is fake. It holds
 * real rows in a real database, assigns its own ids, enforces the same email uniqueness BambooHR
 * enforces, and bumps a revision on every write so the integration layer has something genuine
 * to detect. Nothing downstream can tell the difference by looking at the data.
 */
export class MockBambooHR implements SourceSystem {
  readonly name = "BambooHR (mock)";
  readonly mode = "mock" as const;

  async createEmployee(e: EmployeeInput): Promise<{ sourceId: string; created: boolean }> {
    // Email first, exactly as the live path does: BambooHR rejects duplicate emails, so an
    // apparently-new person with a known email is the same person and must not be created twice.
    const existing = await mockBambooFindByEmail(e.email);
    if (existing && existing !== e.employeeId) {
      throw new StageFailure(
        `${e.email} already belongs to ${existing} in BambooHR — email is a unique key there`, false);
    }
    await mockBambooUpsert(e);
    return { sourceId: e.employeeId, created: !existing };
  }

  count(): Promise<number> { return mockBambooCount(); }

  async health(): Promise<HealthReport> {
    return { ok: true, detail: "in-process mock, backed by syncdemo.mock_bamboohr_employees" };
  }
}

/** The real thing. Every call here creates or reads a record in a live HRIS. */
export class LiveBambooHR implements SourceSystem {
  readonly name = "BambooHR";
  readonly mode = "live" as const;
  private readonly client: BambooHRClient;

  constructor(private readonly cfg: SyncDemoConfig["bamboohr"]) {
    this.client = new BambooHRClient({
      domain: cfg.domain ?? "", apiKey: cfg.apiKey ?? "",
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    });
  }

  async createEmployee(e: EmployeeInput): Promise<{ sourceId: string; created: boolean }> {
    try {
      // findByEmail before create is the idempotency guard, and it is also the recovery path for
      // an ambiguous create: if the POST timed out but BambooHR did create the person, the retry
      // finds them rather than making a twin. This is the behaviour test-writeback.ts asserts.
      const existing = await this.client.findByEmail(e.email);
      if (existing) return { sourceId: existing, created: false };

      const id = await this.client.createEmployee({
        firstName: e.firstName,
        lastName: e.lastName,
        workEmail: e.email,
        ...(e.jobTitle ? { jobTitle: e.jobTitle } : {}),
        ...(e.department ? { department: e.department } : {}),
        ...(e.location ? { location: e.location } : {}),
        ...(e.phone ? { mobilePhone: e.phone } : {}),
        ...(e.hireDate ? { hireDate: e.hireDate } : {}),
      });
      return { sourceId: id, created: true };
    } catch (err) {
      if (err instanceof SeatLimitReached) {
        // A seat cap is not a transient error and retrying it forever is worse than saying so.
        throw new StageFailure(`BambooHR account is at its employee limit — ${err.message}`, false);
      }
      throw new StageFailure(err instanceof Error ? err.message : String(err));
    }
  }

  async count(): Promise<number> {
    try { return await this.client.directorySize(); } catch { return -1; }
  }

  async health(): Promise<HealthReport> {
    try {
      // directorySize() is named for its purpose (the seat-limit preflight) but it counts the
      // custom REPORT, which includes inactive and terminated people — 109 on this tenant
      // against 90 in the public directory. Calling that "in the directory" on a dashboard was
      // simply wrong, and the 19-person gap is exactly the number someone would query.
      const n = await this.client.directorySize();
      return { ok: true, detail: `live tenant ${this.cfg.domain} — ${n} employees in the account (incl. inactive)` };
    } catch (e) {
      // A dead BambooHR trial answers 503 on the API while its portal still redirects, so this
      // message needs to name the tenant rather than just say "unreachable".
      return { ok: false, detail: `tenant ${this.cfg.domain} unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

export function makeSource(cfg: SyncDemoConfig): SourceSystem {
  return cfg.bamboohr.mode === "live" ? new LiveBambooHR(cfg.bamboohr) : new MockBambooHR();
}
