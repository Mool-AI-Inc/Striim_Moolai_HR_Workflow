/**
 * Striim integration layer — mock and live.
 * @lifespan PRODUCTION — the change-detection half of the pipeline.
 * @responsibility Notice a change at the source, transform it, land it in Postgres, say so.
 *
 * READ THIS BEFORE JUDGING THE POLL INTERVALS — they are not arbitrary and they are not the same.
 *
 * Striim's BambooHR Reader is a POLLING reader, not log-based CDC. BambooHR exposes no change
 * feed, so there is nothing to tail. Worse, the connector enforces a floor: creating the source
 * with `PollingInterval: '30s'` is rejected outright with "Please provide a valid value greater
 * than 300s for Polling Interval." Five minutes is the fastest a real BambooHR->Postgres Striim
 * pipeline can notice a new hire, and no configuration changes that.
 *
 * That is a problem for a demo nobody will watch for five minutes, and there are two honest ways
 * to handle it. Pretending is not one of them.
 *
 *   MOCK MODE   the poller below runs at 1.5s against the mock source's revision column. It is a
 *               genuine change detector — watermark, diff, transform, land — just pointed at a
 *               local table and ticking faster. The mechanism is real; the latency is not
 *               representative, and the UI says so.
 *
 *   LIVE MODE   the real Striim application does the work at its real 5-minute cadence. This
 *               adapter does NOT move data in live mode. It reports the application's actual
 *               state over Striim's REST API and watches the landing table that the real reader
 *               writes. When a row appears there, it appeared because Striim put it there.
 *
 * The dashboard shows the mode and the interval, so a viewer is never invited to believe that
 * five-minute enterprise polling is happening in a second and a half.
 */
import type { SyncDemoConfig } from "../config.js";
import {
  appendEvent, bootstrapSkipExisting, getPool, getWatermark, landRow, landingCount,
  mockBambooChangesSince, setWatermark, type EmployeeInput,
} from "../db.js";
import { bus } from "../bus.js";
import { faults, type HealthReport, type IntegrationLayer, type IntegrationStatus } from "./types.js";

/** What the integration layer hands downstream once a row is in the landing table. */
export type LandedHandler = (e: EmployeeInput, revision: number) => Promise<void>;

/**
 * Transform: source shape -> landing shape.
 *
 * Deliberately a named, testable function rather than an inline spread. It is the step the
 * dashboard labels "Transforming employee record", and a demo that labels a step it does not
 * perform is a demo that lies. It normalises the things a real mapping has to normalise:
 * trimmed names, lower-cased email, empty string to null, and a source_system stamp so a row's
 * provenance survives into the intermediate database.
 */
export function transform(e: EmployeeInput): EmployeeInput & { sourceSystem: string } {
  const clean = (v: string | undefined): string | undefined => {
    const t = (v ?? "").trim();
    return t === "" ? undefined : t;
  };
  return {
    employeeId: e.employeeId.trim(),
    firstName: e.firstName.trim(),
    lastName: e.lastName.trim(),
    email: e.email.trim().toLowerCase(),
    ...(clean(e.jobTitle) ? { jobTitle: clean(e.jobTitle) } : {}),
    ...(clean(e.department) ? { department: clean(e.department) } : {}),
    ...(clean(e.location) ? { location: clean(e.location) } : {}),
    ...(clean(e.phone) ? { phone: clean(e.phone) } : {}),
    ...(clean(e.hireDate) ? { hireDate: clean(e.hireDate) } : {}),
    // Carried explicitly. This function rebuilds the record field by field rather than spreading,
    // which is deliberate — but it means any field added upstream is silently DROPPED here until
    // it is listed. payRate was, so the pay figure vanished between the source and the Workday
    // stage, which then correctly refused to write because it had no value. A spread would have
    // hidden the omission; the five-employee test caught it.
    ...(e.payRate === undefined || !Number.isFinite(e.payRate) ? {} : { payRate: e.payRate }),
    sourceSystem: "bamboohr",
  };
}

// ── mock ──────────────────────────────────────────────────────────────────────────────────

export class MockStriim implements IntegrationLayer {
  readonly name = "Striim (mock poller)";
  readonly mode = "mock" as const;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private busy = false;
  private processed = 0;
  private lastEvent: string | undefined;
  private activity = "idle";

  constructor(private readonly pollMs: number, private readonly onLanded: LandedHandler) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.activity = `polling the source every ${this.pollMs}ms`;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    await appendEvent(`Striim pipeline started — polling BambooHR every ${this.pollMs}ms`, { stage: "striim" });
    bus.publish({ type: "systems" });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.activity = "stopped";
    bus.publish({ type: "systems" });
  }

  async pollNow(): Promise<void> { await this.tick(true); }

  /** For the mock the source is a local table, so a poll IS a fresh read of it. */
  async forceRead(): Promise<{ ok: boolean; detail: string }> {
    await this.tick(true);
    return { ok: true, detail: "re-read the source table" };
  }

  /**
   * One CDC read. Guarded against overlap so a slow downstream cannot stack up ticks.
   *
   * `force` exists because pollNow() must work when the interval is NOT running. Without it a
   * manual poll was a no-op whenever the pipeline was stopped, which silently broke the retry
   * button in exactly the situation retry is for. The overlap guard still applies — forcing a
   * poll may not run two at once.
   */
  private async tick(force = false): Promise<void> {
    if (this.busy) return;
    if (!force && !this.running) return;
    if (faults.striimStall) {
      this.activity = "STALLED (fault injected)";
      return;
    }
    this.busy = true;
    try {
      const from = await getWatermark();
      const changes = await mockBambooChangesSince(from);
      if (changes.length === 0) {
        this.activity = `polling the source every ${this.pollMs}ms`;
        return;
      }
      for (const change of changes) {
        const { revision, ...employee } = change;
        this.activity = `processing ${employee.employeeId}`;
        await appendEvent(`Striim detected employee.created event for ${employee.employeeId}`,
          { employeeId: employee.employeeId, stage: "striim" });
        bus.publish({ type: "stage", employeeId: employee.employeeId, stage: "striim", status: "processing", detail: "change detected" });

        await appendEvent(`Striim transforming employee record ${employee.employeeId}`,
          { employeeId: employee.employeeId, stage: "striim" });
        const shaped = transform(employee);

        await appendEvent(`Striim writing ${employee.employeeId} to the PostgreSQL landing table`,
          { employeeId: employee.employeeId, stage: "striim" });
        await landRow(employee.employeeId, shaped, revision);

        this.processed += 1;
        this.lastEvent = `${employee.employeeId} landed`;
        // The watermark advances only after the row is safely landed. Crash before this and the
        // change is re-read next tick, which is what at-least-once delivery means — and why the
        // steps downstream have to be idempotent rather than merely careful.
        await setWatermark(revision);
        await this.onLanded(shaped, revision);
      }
      this.activity = `polling the source every ${this.pollMs}ms`;
    } catch (e) {
      this.activity = `error: ${e instanceof Error ? e.message : String(e)}`;
      await appendEvent(`Striim poll failed: ${e instanceof Error ? e.message : String(e)}`,
        { stage: "striim", level: "error" });
    } finally {
      this.busy = false;
      bus.publish({ type: "systems" });
    }
  }

  async status(): Promise<IntegrationStatus> {
    return {
      pipelineState: this.running ? (faults.striimStall ? "STALLED" : "RUNNING") : "STOPPED",
      eventsProcessed: this.processed,
      ...(this.lastEvent ? { lastEvent: this.lastEvent } : {}),
      activity: this.activity,
    };
  }

  async health(): Promise<HealthReport> {
    const landed = await landingCount();
    return {
      ok: this.running && !faults.striimStall,
      detail: this.running ? `in-process poller, ${landed} rows in the landing table` : "stopped",
    };
  }
}

// ── live ──────────────────────────────────────────────────────────────────────────────────

/**
 * Talks to a real Striim cluster.
 *
 * The REST convention is not the one in Striim's documentation; it is what actually works
 * against this cluster and what striim/deploy.py in this repo uses:
 *   POST /security/authenticate  form-encoded         -> { token }
 *   POST /api/v2/tungsten        text/plain + token   -> [ { executionStatus, output } ]
 * A JSON body gets 415; a STRIIM-TOKEN header gets 401. And a 200 can still carry
 * executionStatus "Failure" in the body, so the status code alone proves nothing.
 */
export class LiveStriim implements IntegrationLayer {
  readonly name = "Striim";
  readonly mode = "live" as const;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private busy = false;
  private processed = 0;
  private lastEvent: string | undefined;
  private activity = "idle";
  private token: string | undefined;
  private appState = "UNKNOWN";

  constructor(
    private readonly cfg: SyncDemoConfig["striim"],
    private readonly pollMs: number,
    private readonly onLanded: LandedHandler,
  ) {}

  private async authenticate(): Promise<string> {
    if (this.token) return this.token;
    const body = new URLSearchParams({ username: this.cfg.user ?? "", password: this.cfg.password ?? "" });
    const r = await fetch(`${this.cfg.url}/security/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) throw new Error(`Striim authenticate -> ${r.status}`);
    const j = (await r.json()) as { token?: string };
    if (!j.token) throw new Error("Striim authenticate returned no token");
    this.token = j.token;
    return this.token;
  }

  private async console(statement: string): Promise<unknown> {
    const token = await this.authenticate();
    const r = await fetch(`${this.cfg.url}/api/v2/tungsten`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "text/plain" },
      body: statement,
    });
    if (r.status === 401) { this.token = undefined; throw new Error("Striim token rejected"); }
    const text = await r.text();
    if (!r.ok) throw new Error(`Striim ${r.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.activity = `watching ${this.cfg.namespace}.${this.cfg.app} and its landing table`;
    // Before the first poll, not after. The landing table already holds the whole tenant, and a
    // poll that ran first would map all of it and send every one of them downstream.
    const skipped = await bootstrapSkipExisting();
    if (skipped > 0) {
      await appendEvent(
        `Baseline taken: ${skipped} employees already in the Striim landing table are marked as `
        + "pre-existing. Only people added to BambooHR from now on will flow through the pipeline.",
        { stage: "striim", level: "warn" });
    }
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    await appendEvent(
      `Watching live Striim application ${this.cfg.namespace}.${this.cfg.app}. `
      + "Its BambooHR reader polls at a 5-minute floor enforced by the connector, so a new hire "
      + "can take that long to land — use Force Striim read to see it immediately.", { stage: "striim" });
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.activity = "stopped";
  }

  async pollNow(): Promise<void> { await this.tick(true); }

  /**
   * Restart the real Striim application to force its bulk read.
   *
   * Measured on this cluster: STOP then START returns Success and the app is back to RUNNING in
   * about ten seconds. Automated mode bulk-reads on start, so this is how a new BambooHR employee
   * reaches the landing table in seconds instead of up to five minutes — and it is still Striim
   * doing the reading and the writing, which a side-channel into BambooHR's API would not be.
   *
   * Not something to lean on repeatedly: each restart re-reads the whole directory.
   */
  async forceRead(): Promise<{ ok: boolean; detail: string }> {
    const app = `${this.cfg.namespace}.${this.cfg.app}`;
    try {
      await appendEvent(`Forcing a Striim read: restarting ${app} (its reader is floored at 300s)`,
        { stage: "striim", level: "warn" });
      await this.console(`STOP APPLICATION ${app};`);
      await this.console(`START APPLICATION ${app};`);
      // Give the bulk read a moment before looking at the landing table, otherwise the poll that
      // follows reports "nothing new" and looks like a failure.
      await new Promise((r) => setTimeout(r, 12_000));
      await this.tick(true);
      const state = this.appState;
      await appendEvent(`Striim ${app} restarted — state ${state}`, { stage: "striim" });
      return { ok: state === "RUNNING", detail: `${app} is ${state}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendEvent(`Forcing a Striim read failed: ${msg}`, { stage: "striim", level: "error" });
      return { ok: false, detail: msg };
    }
  }

  /**
   * In live mode this moves nothing. It reads the application's real state, then looks for rows
   * the real Striim reader has landed in public.bamboohr_employees that have not yet been mapped
   * into the intermediate table, and maps those. If a row is there, Striim put it there.
   *
   * `force` as in the mock: a manual poll has to work while the interval is stopped.
   */
  private async tick(force = false): Promise<void> {
    if (this.busy) return;
    if (!force && !this.running) return;
    this.busy = true;
    try {
      try {
        const res = await this.console(`STATUS ${this.cfg.namespace}.${this.cfg.app};`);
        const first = Array.isArray(res) ? (res[0] as { output?: { status?: string } }) : undefined;
        this.appState = first?.output?.status ?? "UNKNOWN";
      } catch (e) {
        this.appState = "UNREACHABLE";
        this.activity = e instanceof Error ? e.message : String(e);
      }

      // Rows the real reader has landed but which have not been mapped yet. The landing table is
      // the real one Striim's DatabaseWriter created with MigrateSchema, in the public schema.
      const r = await getPool().query(
        `SELECT b.id, b.firstname, b.lastname, b.workemail, b.jobtitle, b.department, b.location,
                b.mobilephone, b.workphone
           FROM public.bamboohr_employees b
           LEFT JOIN syncdemo.employees e ON e.employee_id = b.id
           LEFT JOIN syncdemo.bootstrap_skip k ON k.employee_id = b.id
          WHERE e.employee_id IS NULL
            -- Pre-existing employees are not new hires. See bootstrap_skip in schema.sql.
            AND k.employee_id IS NULL
          ORDER BY (b.id)::int DESC
          LIMIT 25`);

      for (const x of r.rows) {
        const employee: EmployeeInput = {
          employeeId: String(x.id),
          firstName: String(x.firstname ?? ""),
          lastName: String(x.lastname ?? ""),
          email: String(x.workemail ?? `${x.id}@no-email.invalid`),
          ...(x.jobtitle ? { jobTitle: String(x.jobtitle) } : {}),
          ...(x.department ? { department: String(x.department) } : {}),
          ...(x.location ? { location: String(x.location) } : {}),
          ...(x.mobilephone || x.workphone ? { phone: String(x.mobilephone || x.workphone) } : {}),
        };
        await appendEvent(`Striim landed ${employee.employeeId} in public.bamboohr_employees`,
          { employeeId: employee.employeeId, stage: "striim" });
        const shaped = transform(employee);
        await landRow(employee.employeeId, shaped, 1);
        this.processed += 1;
        this.lastEvent = `${employee.employeeId} landed`;
        await this.onLanded(shaped, 1);
      }
      if (this.appState !== "UNREACHABLE") {
        this.activity = `${this.cfg.namespace}.${this.cfg.app} is ${this.appState}; `
                      + `re-checking the landing table every ${Math.round(this.pollMs / 1000)}s`;
      }
    } catch (e) {
      this.activity = `error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.busy = false;
      bus.publish({ type: "systems" });
    }
  }

  async status(): Promise<IntegrationStatus> {
    return {
      pipelineState: this.running ? this.appState : "STOPPED",
      eventsProcessed: this.processed,
      ...(this.lastEvent ? { lastEvent: this.lastEvent } : {}),
      activity: this.activity,
    };
  }

  async health(): Promise<HealthReport> {
    const ok = this.appState === "RUNNING";
    return { ok, detail: `${this.cfg.namespace}.${this.cfg.app}: ${this.appState}` };
  }
}

export function makeIntegration(cfg: SyncDemoConfig, onLanded: LandedHandler): IntegrationLayer {
  return cfg.striim.mode === "live"
    ? new LiveStriim(cfg.striim, cfg.striimLivePollMs, onLanded)
    : new MockStriim(cfg.striimPollMs, onLanded);
}
