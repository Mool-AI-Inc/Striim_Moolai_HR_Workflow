/**
 * The three ports the pipeline talks through.
 * @lifespan PRODUCTION — the seam that makes live and mock interchangeable.
 * @responsibility Define behaviour, not implementation. No I/O here.
 *
 * Each system has exactly one interface and two implementations. The pipeline never learns which
 * it holds, which is what keeps "demo mode" from being a separate code path that can rot: the
 * mock and the live adapter are exercised by the same orchestrator, the same idempotency, the
 * same retries and the same tests.
 */
import type { EmployeeInput } from "../db.js";

export interface HealthReport {
  ok: boolean;
  /** One short line for the dashboard's connection indicator. */
  detail: string;
}

/** The source system. Employees originate here and nowhere else. */
export interface SourceSystem {
  readonly name: string;
  readonly mode: "mock" | "live";
  /**
   * Create the employee. Returns the id the source assigned.
   *
   * MUST be idempotent on email: called twice with the same person, it returns the existing id
   * rather than creating a second record. Both implementations do this by looking the email up
   * first — email is a natural key in BambooHR, which rejects duplicates.
   */
  createEmployee(e: EmployeeInput): Promise<{ sourceId: string; created: boolean }>;
  count(): Promise<number>;
  health(): Promise<HealthReport>;
}

/** What the integration layer reports about itself. Read by the dashboard's Striim card. */
export interface IntegrationStatus {
  /** RUNNING / STOPPED / HALT for real Striim; RUNNING / STOPPED for the poller. */
  pipelineState: string;
  eventsProcessed: number;
  lastEvent?: string;
  /** Human sentence for the card: what it is doing right now. */
  activity: string;
}

/**
 * The integration layer: detects a change at the source and lands it in Postgres.
 *
 * `start` begins watching. Everything after that is driven by what the adapter observes, not by
 * the API call that created the employee — which is the whole point. The HTTP request that
 * creates an employee in BambooHR returns as soon as BambooHR has it; the pipeline then finds
 * the change on its own, exactly as a CDC reader would.
 */
export interface IntegrationLayer {
  readonly name: string;
  readonly mode: "mock" | "live";
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<IntegrationStatus>;
  health(): Promise<HealthReport>;
  /**
   * Ask for one immediate poll instead of waiting for the next tick. Used by the retry button.
   * Not used by the create path — a demo that secretly nudges the pipeline the moment it writes
   * to the source is not demonstrating change detection.
   */
  pollNow(): Promise<void>;
  /**
   * Make the integration layer re-read the SOURCE right now, not just re-check what it already
   * landed.
   *
   * This exists because of a hard limit: Striim's BambooHR Reader is floored at a 300s polling
   * interval by the connector, so a new hire can take five minutes to be noticed and no setting
   * changes that. What DOES force an immediate read is restarting the application — Automated mode
   * performs a bulk read on start. So the live adapter stops and starts the real Striim app, and
   * the data still arrives via Striim rather than via a shortcut around it.
   */
  forceRead(): Promise<{ ok: boolean; detail: string }>;
}

/** The target system: where the record ends up. */
export interface TargetSystem {
  readonly name: string;
  readonly mode: "mock" | "live";
  /** Idempotent on employeeId: a second call updates, it does not create a second worker. */
  sync(e: EmployeeInput): Promise<{ targetId: string; created: boolean; detail: string }>;
  count(): Promise<number>;
  latest(): Promise<{ label: string; at: string } | undefined>;
  health(): Promise<HealthReport>;
}

/**
 * Deliberate failure injection, so the error states in the brief are demonstrable rather than
 * theoretical. Toggled from the dashboard; never on by default.
 */
export interface FaultSwitches {
  postgresDown: boolean;
  workdayFail: boolean;
  striimStall: boolean;
}

export const faults: FaultSwitches = {
  postgresDown: false,
  workdayFail: false,
  striimStall: false,
};

export class StageFailure extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = "StageFailure";
  }
}
