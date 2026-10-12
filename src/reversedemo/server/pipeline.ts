/**
 * Reverse pipeline: Workday/Adaptive -> Striim -> PostgreSQL -> BambooHR.
 * @lifespan PRODUCTION — the orchestrator and both adapters.
 * @responsibility Read Workday, map, land, create in BambooHR. Exactly once per person.
 *
 * THE SAFETY PROPERTY THAT SHAPES THIS FILE
 *
 * A BambooHR create is PERMANENT. The API has no delete — only termination — and every create
 * consumes a seat on the account. So there is no automatic import loop here: Workday holds 523
 * people, and a poller that imported them unattended would leave 523 permanent human records in a
 * real HRIS and exhaust the trial. An operator imports one person at a time, deliberately.
 *
 * That is also why the mapping is RESERVED before the HRIS is called, not after it returns. A
 * crash mid-create otherwise leaves no local trace and the retry makes a second person.
 */
import { AdaptiveClient } from "../../platform/hris/adaptiveClient.js";
import { BambooHRClient, SeatLimitReached } from "../../platform/hris/bamboohrClient.js";
import { bus } from "./bus.js";
import {
  allStages, appendEvent, claimStep, createdCount, employeeCount, getLandedMember, getMapping,
  importable, landMembers, landingCount, listEmployees, mappingSummary, ping, recentEvents,
  releaseStep, reserveMapping, resetLocal, setMapping, setStage, setSyncStatus, stagesFor,
  upsertEmployee, getTargetPool, targetCount, targetHasMember,
  type MappedEmployee, type Stage, type StageStatus, type WorkdayMember,
} from "./db.js";
import { loadReverseConfig, publicReverseConfig, type ReverseConfig } from "./config.js";

export class StageFailure extends Error {
  constructor(message: string, readonly retryable = true) { super(message); this.name = "StageFailure"; }
}

// ── mapping: Workday's shape -> our contract ───────────────────────────────────────────────

/**
 * Split a single `Worker_Name` into first and last.
 *
 * Adaptive stores one display name, so this is a genuine lossy guess and it is isolated here
 * rather than inlined, because "everything after the first token is the surname" is wrong for
 * "Maria del Carmen Lopez" and right for most of this dataset. A real migration would source the
 * name parts from the HRIS of record; there is nothing better available on this sheet.
 */
export function splitName(workerName: string): { firstName: string; lastName: string } {
  const parts = workerName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Unknown", lastName: "Unknown" };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: "-" };
  return { firstName: parts[0] as string, lastName: parts.slice(1).join(" ") };
}

/**
 * Synthesise a work email.
 *
 * Adaptive carries no email at all, and BambooHR requires one and rejects duplicates — so email
 * is both mandatory and the natural idempotency key. The member id is included to guarantee
 * uniqueness: two "Jamie Stone"s on the sheet must not collide into one BambooHR person.
 *
 * The domain is configurable and defaults to a reserved example domain, so nothing that lands in
 * a real HRIS looks like a deliverable corporate address.
 */
export function synthEmail(member: WorkdayMember, domain: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
  const { firstName, lastName } = splitName(member.workerName);
  const id = slug(member.memberId) || "member";
  const name = [slug(firstName), slug(lastName)].filter(Boolean).join(".") || "worker";
  return `${name}.${id}@${domain}`;
}

export function mapMember(member: WorkdayMember, domain: string): MappedEmployee {
  const { firstName, lastName } = splitName(member.workerName);
  // Job_Group and Job_Classification on this sheet are sometimes the literal placeholder strings
  // "Job_Group" / "Job_Classification" rather than real values. Passing those through would put
  // nonsense in an HRIS, so they are dropped.
  const real = (v: string | undefined, placeholder: string) =>
    !v || v === placeholder ? undefined : v;
  return {
    memberId: member.memberId,
    firstName, lastName,
    email: synthEmail(member, domain),
    ...(real(member.jobClass, "Job_Classification") ? { jobTitle: member.jobClass } : {}),
    ...(real(member.jobGroup, "Job_Group") ? { department: member.jobGroup } : {}),
    ...(member.location ? { location: member.location } : {}),
    ...(member.payRate === undefined ? {} : { payRate: member.payRate }),
  };
}

// ── Workday source (read) ──────────────────────────────────────────────────────────────────

export class WorkdaySource {
  readonly name = "Workday Adaptive Planning";
  readonly mode: "live" | "mock";
  private readonly client: AdaptiveClient | undefined;

  constructor(private readonly cfg: ReverseConfig) {
    this.mode = cfg.workday.mode;
    if (this.mode !== "live") return;
    this.client = new AdaptiveClient({
      apiUrl: cfg.workday.apiUrl ?? "", tokenUrl: cfg.workday.tokenUrl ?? "",
      tokenExchangeUrl: cfg.workday.tokenExchangeUrl ?? "",
      clientId: cfg.workday.clientId ?? "", clientSecret: cfg.workday.clientSecret ?? "",
      refreshToken: cfg.workday.refreshToken ?? "",
      version: cfg.workday.version ?? "default",
      ...(cfg.workday.instanceCode ? { instanceCode: cfg.workday.instanceCode } : {}),
      level: cfg.workday.levelCode, sheetName: cfg.workday.sheetName,
      importKey: cfg.workday.importKey,
    });
  }

  /** exportData over the sheet. Read-only — this direction never writes to Adaptive. */
  async fetchAll(): Promise<WorkdayMember[]> {
    if (!this.client) return this.sample();
    const token = await this.client.authenticate();
    const xa = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const dims = ["Gender", "Location", "Job_Group", "Job_Classification", "Worker_Name", "EmpID_EUPTD"];
    const month = this.cfg.workday.readMonth
      || new Date().toISOString().slice(0, 7).split("-").reverse().join("/");

    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<call method="exportData" callerName="MoolaiReversePipeline">
  <credentials token="${xa(token)}" instanceCode="${xa(this.cfg.workday.instanceCode ?? "")}"/>
  <version name="${xa(this.cfg.workday.version ?? "")}" isDefault="false"/>
  <format useInternalCodes="true" includeUnmappedItems="false"/>
  <filters>
    <accounts><account code="${xa(this.cfg.workday.account)}" isAssumption="false" includeDescendants="false"/></accounts>
    <timeSpan start="${xa(month)}" end="${xa(month)}"/>
  </filters>
  <dimensions>
${dims.map((d) => `    <dimension name="${xa(d)}"/>`).join("\n")}
  </dimensions>
  <rules includeZeroRows="true" includeRollupAccounts="false" includeRollupLevels="false" markInvalidValues="false">
    <currency useLocal="true"/>
  </rules>
</call>`;

    const r = await fetch(this.cfg.workday.apiUrl ?? "", {
      method: "POST", headers: { "Content-Type": "application/xml" }, body: xml,
    });
    const text = await r.text();
    if (!/success="true"/.test(text)) {
      throw new StageFailure(`Adaptive exportData failed: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    const csv = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(text)?.[1] ?? "";
    const lines = csv.trim().split("\n");
    // [Account Name, Account Code, Level Name, ...dims, ...months]
    const base = 3;
    const out: WorkdayMember[] = [];
    for (const line of lines.slice(1)) {
      // Values are quoted; a naive split is adequate because none of these dimensions contains a
      // comma on this sheet, and a CSV parser for six known columns would be more code than value.
      const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
      const memberId = cols[base + 5];
      if (!memberId) continue;
      const pay = Number(cols[base + dims.length]);
      out.push({
        memberId,
        workerName: cols[base + 4] ?? "",
        ...(cols[base] ? { gender: cols[base] } : {}),
        ...(cols[base + 1] ? { location: cols[base + 1] } : {}),
        ...(cols[base + 2] ? { jobGroup: cols[base + 2] } : {}),
        ...(cols[base + 3] ? { jobClass: cols[base + 3] } : {}),
        ...(cols[2] ? { levelCode: cols[2] } : {}),
        ...(Number.isFinite(pay) ? { payRate: pay } : {}),
      });
    }
    return out;
  }

  /** Enough shape to exercise the pipeline with no Adaptive credentials. */
  private sample(): WorkdayMember[] {
    return [
      { memberId: "EMP_0019", workerName: "Jan Wilmer", gender: "Female", location: "Sydney", jobClass: "101 - Junior Financial Analyst", payRate: 27 },
      { memberId: "EMP_0337", workerName: "Jamie Stone", gender: "Female", location: "Boston", jobClass: "101 - Junior Financial Analyst", payRate: 120849 },
      { memberId: "EMP_0042", workerName: "Florian Peeters", gender: "Male", location: "Brussels", jobClass: "104 - Software Developer I", payRate: 47301 },
    ];
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.client) return { ok: true, detail: "mock source (3 sample members)" };
    try {
      const token = await this.client.authenticate();
      return { ok: true, detail: `authenticated to ${this.cfg.workday.instanceCode ?? "Adaptive"} (token ${token.length} chars)` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

// ── BambooHR target (write) ────────────────────────────────────────────────────────────────

export class BambooTarget {
  readonly name: string;
  readonly mode: "live" | "mock";
  private readonly client: BambooHRClient | undefined;

  constructor(private readonly cfg: ReverseConfig) {
    this.mode = cfg.bamboohr.mode;
    this.name = this.mode === "live" ? "BambooHR" : "BambooHR (mock)";
    if (this.mode !== "live") return;
    this.client = new BambooHRClient({
      domain: cfg.bamboohr.domain ?? "", apiKey: cfg.bamboohr.apiKey ?? "",
    });
  }

  /** Idempotent on email, which BambooHR treats as unique. */
  async create(e: MappedEmployee): Promise<{ id: string; created: boolean }> {
    if (!this.client) {
      // The mock still returns a stable id derived from the member, so idempotency is observable
      // without creating a permanent record anywhere.
      return { id: `MOCK-${e.memberId}`, created: true };
    }
    const existing = await this.client.findByEmail(e.email);
    if (existing) return { id: existing, created: false };
    try {
      const id = await this.client.createEmployee({
        firstName: e.firstName, lastName: e.lastName, workEmail: e.email,
        ...(e.jobTitle ? { jobTitle: e.jobTitle } : {}),
        ...(e.department ? { department: e.department } : {}),
        ...(e.location ? { location: e.location } : {}),
      });
      return { id, created: true };
    } catch (err) {
      if (err instanceof SeatLimitReached) {
        throw new StageFailure(
          `BambooHR is at its employee limit — ${err.message}. Retrying will not help; the account `
          + "needs seats freed or raised.", false);
      }
      throw new StageFailure(err instanceof Error ? err.message : String(err));
    }
  }

  async count(): Promise<number> {
    if (!this.client) return createdCount();
    try { return await this.client.directorySize(); } catch { return -1; }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.client) return { ok: true, detail: "mock target — nothing is written to a real HRIS" };
    try {
      const n = await this.client.directorySize();
      return { ok: true, detail: `live tenant ${this.cfg.bamboohr.domain} — ${n} employees in the account` };
    } catch (e) {
      return { ok: false, detail: `tenant ${this.cfg.bamboohr.domain} unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

// ── orchestrator ───────────────────────────────────────────────────────────────────────────

export class ReversePipeline {
  readonly source: WorkdaySource;
  readonly target: BambooTarget;

  constructor(private readonly cfg: ReverseConfig) {
    this.source = new WorkdaySource(cfg);
    this.target = new BambooTarget(cfg);
    // Opened eagerly in live mode so a missing TARGET_DATABASE_URL fails at boot rather than
    // half-way through an import, with a person already written upstream.
    if (cfg.striimMode === "live") {
      if (!cfg.targetDatabaseUrl) {
        throw new Error(
          "REVDEMO_STRIIM_MODE=live needs REVDEMO_TARGET_DATABASE_URL (or TARGET_DATABASE_URL) — "
          + "that is the database Striim replicates into, and the BambooHR stage reads it.");
      }
      getTargetPool(cfg.targetDatabaseUrl);
    }
  }

  private async mark(memberId: string, stage: Stage, status: StageStatus, detail?: string, bump = false): Promise<void> {
    await setStage(memberId, stage, status, detail, bump);
    bus.publish({ type: "stage", employeeId: memberId, stage: stage as never, status: status as never, ...(detail ? { detail } : {}) });
  }

  private async log(message: string, memberId?: string, stage?: Stage, level: "info" | "success" | "warn" | "error" = "info"): Promise<void> {
    const row = await appendEvent(message, {
      ...(memberId ? { memberId } : {}), ...(stage ? { stage } : {}), level,
    });
    bus.publish({ type: "event", event: row as never });
  }

  /**
   * Stage 1: read Workday and land what it says. Read-only against Adaptive.
   *
   * `quiet` suppresses the per-read log line. The poller passes it, because a line every 30
   * seconds saying "read 530 members" buries the one line that matters — a NEW member
   * appearing — and the activity log is the thing people watch during a demo.
   */
  async refreshFromWorkday(quiet = false): Promise<{ members: number; added: string[] }> {
    if (!quiet) await this.log(`Reading employees from ${this.source.name}`, undefined, "workday");
    const before = new Set((await importable(1000)).map((c) => c.memberId));
    const members = await this.source.fetchAll();
    const n = await landMembers(members);
    const added = members.map((m) => m.memberId).filter((id) => !before.has(id));

    // A new member in the source is the event worth announcing, so it is logged even when the
    // read itself is quiet. This is what makes "add someone in Workday and watch" work.
    for (const id of added) {
      const who = members.find((m) => m.memberId === id);
      await this.log(
        `New Workday member detected: ${id}${who?.workerName ? ` (${who.workerName})` : ""}`
        + " — ready to import",
        id, "workday", "success");
    }
    if (!quiet) {
      await this.log(
        `Workday returned ${members.length} members; ${n} landed in PostgreSQL`,
        undefined, "workday", "success");
    }
    bus.publish({ type: "systems" });
    return { members: n, added };
  }

  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;

  /** Start watching Workday for new members. Read-only; never imports. */
  startWorkdayPoller(): void {
    if (this.cfg.workdayPollMs <= 0 || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      // Guarded against overlap: an exportData over 530 rows can outlast a short interval,
      // and two in flight would double-count arrivals.
      if (this.polling) return;
      this.polling = true;
      void this.refreshFromWorkday(true)
        .catch(async (e: Error) => {
          await this.log(`Workday poll failed: ${e.message}`, undefined, "workday", "error");
        })
        .finally(() => { this.polling = false; });
    }, this.cfg.workdayPollMs);
  }

  stopWorkdayPoller(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
  }

  /**
   * Stages 2-4 for one person: map, write to the intermediate table, create in BambooHR.
   *
   * Deliberately one person per call. See the file header: a BambooHR create is permanent.
   */
  async importMember(memberId: string): Promise<{ memberId: string; bambooEmployeeId?: string; created: boolean }> {
    const member = await getLandedMember(memberId);
    if (!member) throw new StageFailure(`${memberId} is not in the Workday landing table — refresh first`, false);

    for (const stage of ["workday", "striim", "postgres", "bamboohr"] as Stage[]) {
      await this.mark(memberId, stage, "pending");
    }
    await this.mark(memberId, "workday", "synced", `read from ${this.source.name}`);

    // Stage 2a — the transform. Ours in either mode: Striim has no Adaptive reader.
    await this.mark(memberId, "striim", "processing", "transforming the Workday record");
    await this.log(`Transforming ${memberId} (${member.workerName})`, memberId, "striim");
    const mapped = mapMember(member, this.cfg.emailDomain);
    await this.log(
      `Synthesised work email ${mapped.email} — Adaptive carries no email and BambooHR requires one`,
      memberId, "striim");

    // Stage 3 — the intermediate database.
    if (await claimStep(memberId, "postgres")) {
      await this.mark(memberId, "postgres", "processing", "writing the record");
      try {
        await upsertEmployee(mapped);
        await this.mark(memberId, "postgres", "synced", "row committed");
        await this.log(`PostgreSQL INSERT successful for ${memberId}`, memberId, "postgres", "success");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await releaseStep(memberId, "postgres");
        await this.mark(memberId, "postgres", "failed", msg, true);
        await this.log(`PostgreSQL write failed for ${memberId}: ${msg}`, memberId, "postgres", "error");
        bus.publish({ type: "systems" });
        throw new StageFailure(msg);
      }
    } else {
      await this.mark(memberId, "postgres", "synced", "already applied (idempotent)");
    }

    // Stage 2b — Striim. ORDER MATTERS: the row is now in the SOURCE database, and the real
    // Striim application replicates revdemo.employees into the TARGET database. We wait for it
    // to arrive there before calling BambooHR, which is what makes the Striim stage load-
    // bearing rather than a label: switch the app off and nothing reaches the HRIS.
    //
    // This is log-based CDC over wal2json, so there is no polling floor — measured at 15s.
    if (this.cfg.striimMode === "live") {
      await this.mark(memberId, "striim", "processing",
        `waiting for ${this.cfg.striimApp} to replicate the row`);
      await this.log(
        `Waiting for Striim (${this.cfg.striimApp}) to replicate ${memberId} into the target database`,
        memberId, "striim");
      const deadline = Date.now() + this.cfg.striimWaitMs;
      let delivered = false;
      while (Date.now() < deadline) {
        if (await targetHasMember(memberId)) { delivered = true; break; }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!delivered) {
        const why = `Striim did not replicate ${memberId} within `
                  + `${Math.round(this.cfg.striimWaitMs / 1000)}s. Check `
                  + `\`python striim/deploy.py status\` — ${this.cfg.striimApp} may be in HALT, `
                  + "or its replication slot may have been dropped.";
        await this.mark(memberId, "striim", "failed", why, true);
        await this.log(why, memberId, "striim", "error");
        bus.publish({ type: "systems" });
        throw new StageFailure(why);
      }
      await this.mark(memberId, "striim", "synced", "replicated to the target database by Striim");
      await this.log(`Striim replicated ${memberId} into the target database`, memberId, "striim", "success");
    } else {
      await this.mark(memberId, "striim", "synced",
        `mapped to ${mapped.firstName} ${mapped.lastName} (in-process, Striim not in the path)`);
    }

    // Stage 4 — BambooHR.
    const existing = await getMapping(memberId);
    if (existing?.status === "CREATED" && existing.bambooEmployeeId) {
      await this.mark(memberId, "bamboohr", "synced",
        `already created as ${existing.bambooEmployeeId} — not duplicated`);
      await this.log(
        `${memberId} already exists in BambooHR as ${existing.bambooEmployeeId} — skipped`,
        memberId, "bamboohr");
      await setSyncStatus(memberId, "synced");
      bus.publish({ type: "systems" });
      return { memberId, bambooEmployeeId: existing.bambooEmployeeId, created: false };
    }

    // Reserved BEFORE the call. A crash between here and the response must leave a trace.
    await reserveMapping(memberId, mapped.email);
    await setMapping(memberId, "CREATING", `creating ${mapped.email} in ${this.target.name}`);
    await this.mark(memberId, "bamboohr", "processing", `creating in ${this.target.name}`);
    await this.log(`PostgreSQL → BambooHR: creating ${mapped.firstName} ${mapped.lastName}`, memberId, "bamboohr");

    try {
      const { id, created } = await this.target.create(mapped);
      await setMapping(memberId, "CREATED",
        created ? `created as ${id}` : `matched existing ${id} by email — not duplicated`, id);
      await this.mark(memberId, "bamboohr", "synced", created ? `created as ${id}` : `matched existing ${id}`);
      await this.log(
        `BambooHR employee ${created ? "created" : "matched"} for ${memberId}: id ${id}`,
        memberId, "bamboohr", "success");
      await setSyncStatus(memberId, "synced");
      await this.log(`${memberId} pipeline completed`, memberId, undefined, "success");
      bus.publish({ type: "systems" });
      return { memberId, bambooEmployeeId: id, created };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await setMapping(memberId, "FAILED", msg);
      await this.mark(memberId, "bamboohr", "failed", msg, true);
      await this.log(`BambooHR create failed for ${memberId}: ${msg}`, memberId, "bamboohr", "error");
      await setSyncStatus(memberId, "failed");
      bus.publish({ type: "systems" });
      throw e;
    }
  }

  async retry(memberId: string): Promise<{ ok: boolean }> {
    const stages = await stagesFor(memberId);
    if (!stages.some((s) => s.status === "failed")) return { ok: true };
    await this.log(`Retrying ${memberId}`, memberId, undefined, "warn");
    try { await this.importMember(memberId); return { ok: true }; } catch { return { ok: false }; }
  }

  async snapshot() {
    const [
      employees, stages, events, pgUp, pgCount, landed, candidates, mapSummary,
      srcHealth, tgtHealth, tgtCount, replicated,
    ] = await Promise.all([
      listEmployees(50), allStages(), recentEvents(80), ping(), employeeCount(), landingCount(),
      importable(200), mappingSummary(),
      this.source.health().catch((e: Error) => ({ ok: false, detail: e.message })),
      this.target.health().catch((e: Error) => ({ ok: false, detail: e.message })),
      this.target.count().catch(() => -1),
      this.cfg.striimMode === "live" ? targetCount().catch(() => -1) : employeeCount(),
    ]);

    return {
      config: publicReverseConfig(this.cfg),
      systems: {
        workday: { name: this.source.name, mode: this.source.mode, count: landed, health: srcHealth },
        striim: {
          name: this.cfg.striimMode === "live" ? `Striim · ${this.cfg.striimApp}` : "Striim",
          mode: this.cfg.striimMode,
          health: { ok: true, detail: this.cfg.striimNote },
          // In live mode this is the row count in the TARGET database — what Striim has
          // actually delivered, not what we wrote upstream of it.
          count: replicated,
        },
        postgres: {
          name: "PostgreSQL", mode: "live" as const, count: pgCount,
          health: { ok: pgUp, detail: pgUp ? publicReverseConfig(this.cfg).database : "unreachable" },
        },
        bamboohr: {
          name: this.target.name, mode: this.target.mode, count: tgtCount, health: tgtHealth,
          created: mapSummary.CREATED, failed: mapSummary.FAILED,
        },
      },
      mappingSummary: mapSummary,
      candidates,
      employees: employees.map((e) => ({ ...e, stages: stages[e.memberId] ?? [] })),
      events,
    };
  }

  async reset(): Promise<void> {
    await resetLocal();
    bus.publish({ type: "reset" });
    await this.log(
      "Local state cleared. NOTE: BambooHR creates are permanent — this does not delete anyone; "
      + "re-importing matches them by email instead.", undefined, undefined, "warn");
    bus.publish({ type: "systems" });
  }
}

export { loadReverseConfig };
