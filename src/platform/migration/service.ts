/**
 * The migration, as one object the operator surface can drive.
 * @lifespan PRODUCTION — holds the two pools, the Striim client, and which side is live.
 * @responsibility Own the source/target connections and expose exactly the operations the
 *   panel offers: status, start CDC, initial load, cutover, reconcile, reset.
 *
 * Note the asymmetry. `sourceUrl` is captured once, at construction, and never changes.
 * `LEDGER_DATABASE_URL` is what the application writes through, and the cutover repoints
 * it — so after the flip they differ, and the panel can still count both sides.
 */
import { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { closePool } from "../db/pool.js";
import { guardPool, NEON_POOL_DEFAULTS } from "../db/poolGuard.js";
import { StriimClient } from "./striimClient.js";
import { reconcile, type TableComparison } from "./reconcile.js";
import { advanceSequences, type SequenceState } from "./sequences.js";
import { ensureSlot, slotState, dropSlot, type SlotState } from "./slot.js";
import { cutover, CutoverRefused, type CutoverStep } from "./cutover.js";
import { MIGRATED_TABLES } from "./tables.js";

export const CDC_APP = "InstantTeamsCDC";
export const LOAD_APP = "InstantTeamsInitialLoad";

export interface MigrationStatus {
  sourceUrlLabel: string;
  targetUrlLabel: string;
  writingTo: "source" | "target";
  acceptingStarts: boolean;
  cdcState: string;
  loadState: string;
  slot: SlotState;
  /** True once the slot has been observed held. Sticky — see slot.ts on the 30s cycle. */
  slotReady: boolean;
  tables: TableComparison[];
  lastCutover: CutoverStep[] | null;
  lastError: string | null;
}

/** Hide the password when a connection string is shown to a person. */
function label(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url ? "(unparseable url)" : "(not set)";
  }
}

export class MigrationService {
  private readonly sourceUrl: string;
  private readonly targetUrl: string;
  private readonly source: Pool;
  private readonly target: Pool;
  private readonly striim: StriimClient;
  private readonly slotName: string;

  private acceptingStarts = true;
  private slotEverHeld = false;
  private lastCutover: CutoverStep[] | null = null;
  private lastError: string | null = null;
  private flipped = false;

  constructor() {
    const env = loadEnv();
    this.sourceUrl = env.ledgerDatabaseUrl;
    this.targetUrl = env.targetDatabaseUrl;
    this.slotName = env.striim.slot;
    this.source = guardPool(new Pool({ ...NEON_POOL_DEFAULTS, connectionString: this.sourceUrl }), "migration-source");
    this.target = guardPool(new Pool({ ...NEON_POOL_DEFAULTS, connectionString: this.targetUrl }), "migration-target");
    this.striim = new StriimClient(env.striim);
  }

  isAcceptingStarts(): boolean { return this.acceptingStarts; }

  async status(): Promise<MigrationStatus> {
    const [cdcState, loadState, slot, tables] = await Promise.all([
      this.striim.appState(CDC_APP).catch((e: Error) => `error: ${e.message.slice(0, 80)}`),
      this.striim.appState(LOAD_APP).catch((e: Error) => `error: ${e.message.slice(0, 80)}`),
      slotState(this.source, this.slotName).catch(() => emptySlot(this.slotName)),
      reconcile(this.source, this.target).catch(() => [] as TableComparison[]),
    ]);
    if (slot.active) this.slotEverHeld = true;
    return {
      sourceUrlLabel: label(this.sourceUrl),
      targetUrlLabel: label(this.targetUrl),
      writingTo: this.flipped ? "target" : "source",
      acceptingStarts: this.acceptingStarts,
      cdcState, loadState, slot,
      slotReady: this.slotEverHeld,
      tables,
      lastCutover: this.lastCutover,
      lastError: this.lastError,
    };
  }

  /** Create the slot, then start CDC. The slot first, always — Striim will not make it. */
  async startCdc(): Promise<SlotState> {
    this.lastError = null;
    const slot = await ensureSlot(this.source, this.slotName);
    await this.striim.start(CDC_APP);
    return slot;
  }

  /**
   * Start the bulk load. Refuses until the SLOT is held — not until the app says RUNNING,
   * which happens about fifteen seconds earlier. See slot.ts.
   */
  async startInitialLoad(): Promise<void> {
    const slot = await slotState(this.source, this.slotName);
    if (slot.active) this.slotEverHeld = true;
    if (!slot.exists) throw new CutoverRefused("the replication slot does not exist yet", "initial-load");
    if (!this.slotEverHeld) {
      throw new CutoverRefused(
        "the replication slot is not being held yet — starting the bulk load now would lose "
        + "any write that lands before CDC attaches", "initial-load",
      );
    }
    await this.striim.start(LOAD_APP);
  }

  reconcileNow(): Promise<TableComparison[]> {
    return reconcile(this.source, this.target);
  }

  async cutoverNow(): Promise<CutoverStep[]> {
    this.lastError = null;
    try {
      const steps = await cutover({
        setAcceptingStarts: (a) => { this.acceptingStarts = a; },
        reconcile: () => reconcile(this.source, this.target),
        cdcState: () => this.striim.appState(CDC_APP),
        stopCdc: () => this.striim.stop(CDC_APP),
        advanceSequences: (): Promise<SequenceState[]> => advanceSequences(this.target),
        flip: async () => {
          // The seam env.ts was built with: loadEnv reads process.env at CALL time, and
          // getPool() rebuilds lazily from it. So repointing the variable and closing the
          // pool moves the application to the target with no process restart, no worker
          // shutdown and no dropped Temporal tasks.
          // ponytail: runtime mutation of process.env. Acceptable in a demo entrypoint;
          // the production upgrade path is an injected config object.
          process.env.LEDGER_DATABASE_URL = this.targetUrl;
          await closePool();
          this.flipped = true;
        },
      }, { drainTimeoutMs: 120_000, pollMs: 2_000 });
      this.lastCutover = steps;
      return steps;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastCutover = null;
      throw error;
    }
  }

  /**
   * Put everything back so the whole thing can be run again.
   * A demo you cannot re-run is a demo you cannot rehearse.
   */
  async reset(): Promise<{ truncated: string[] }> {
    this.lastError = null;
    this.lastCutover = null;
    await this.striim.stop(CDC_APP).catch(() => {});
    await this.striim.stop(LOAD_APP).catch(() => {});
    // Table names come from the MIGRATED_TABLES constant, never from a request body.
    for (const table of MIGRATED_TABLES) {
      await this.target.query(`TRUNCATE TABLE public.${table} CASCADE`);
    }
    await dropSlot(this.source, this.slotName).catch(() => {});
    this.slotEverHeld = false;
    this.flipped = false;
    this.acceptingStarts = true;
    process.env.LEDGER_DATABASE_URL = this.sourceUrl;
    await closePool();
    return { truncated: [...MIGRATED_TABLES] };
  }

  async close(): Promise<void> {
    await this.source.end().catch(() => {});
    await this.target.end().catch(() => {});
  }
}

function emptySlot(name: string): SlotState {
  return { name, exists: false, active: false, plugin: null, restartLsn: null,
           confirmedFlushLsn: null, currentWalLsn: null };
}
