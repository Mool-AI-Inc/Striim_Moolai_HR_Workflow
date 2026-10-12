/**
 * The cutover, and what it refuses.
 * @lifespan PRODUCTION — the ordered switch from source to target.
 * @responsibility Run five steps in one order, and refuse rather than proceed when a
 *   precondition is not met. The refusals are the point: order is what makes a cutover
 *   safe, and a cutover that proceeds in the wrong order fails SILENTLY.
 *
 * Dependencies are injected so every refusal is unit-testable with no Striim and no
 * Postgres.
 */
import type { TableComparison } from "./reconcile.js";
import type { SequenceState } from "./sequences.js";

export interface CutoverDeps {
  setAcceptingStarts: (accepting: boolean) => void | Promise<void>;
  reconcile: () => Promise<TableComparison[]>;
  cdcState: () => Promise<string>;
  stopCdc: () => Promise<void>;
  advanceSequences: () => Promise<SequenceState[]>;
  flip: () => Promise<void>;
}

export interface CutoverOptions { drainTimeoutMs?: number; pollMs?: number; }

export interface CutoverStep { name: string; ok: boolean; detail?: string; }

export class CutoverRefused extends Error {
  constructor(message: string, readonly step: string) {
    super(message);
    this.name = "CutoverRefused";
  }
}

/** States in which it is NOT safe to point the application at the target. */
const STOPPED_STATES = new Set(["STOPPED", "CREATED", "COMPLETED", "TERMINATED", "QUIESCED"]);

export async function cutover(deps: CutoverDeps, opts: CutoverOptions = {}): Promise<CutoverStep[]> {
  const drainTimeoutMs = opts.drainTimeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2_000;
  const steps: CutoverStep[] = [];

  // 1. Quiesce. New workflow starts are refused; in-flight work keeps running and parked
  //    approvals stay parked. This bounds how fast the source can move during the drain.
  await deps.setAcceptingStarts(false);
  steps.push({ name: "quiesce", ok: true, detail: "new workflow starts refused" });

  try {
    // 2. Drain. Block until both sides agree on rows AND checksums. Deliberately a poll on
    //    real evidence rather than a sleep: proceeding on a timer is how you cut over
    //    mid-stream and find out weeks later.
    const deadline = Date.now() + drainTimeoutMs;
    let comparisons = await deps.reconcile();
    while (!comparisons.every((c) => c.match) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      comparisons = await deps.reconcile();
    }
    if (!comparisons.every((c) => c.match)) {
      const behind = comparisons.filter((c) => !c.match)
        .map((c) => `${c.table} (source ${c.source.rows} / target ${c.target.rows})`).join(", ");
      throw new CutoverRefused(`drain did not converge within ${drainTimeoutMs}ms: ${behind}`, "drain");
    }
    steps.push({ name: "drain", ok: true, detail: "row counts and checksums match on every table" });

    // 3. Stop CDC. NON-NEGOTIABLE, and it must happen before the flip. The moment the
    //    application writes to the target, a still-running CDC app is replicating into the
    //    new primary. That is split brain, and nothing reports it.
    await deps.stopCdc();
    const state = await deps.cdcState();
    if (!STOPPED_STATES.has(state)) {
      // UNKNOWN lands here on purpose. "I could not tell" is not "it is stopped", and
      // flipping on a shrug is exactly the failure this whole function exists to prevent.
      throw new CutoverRefused(`CDC is ${state} after the stop; refusing to flip`, "stop-cdc");
    }
    steps.push({ name: "stop-cdc", ok: true, detail: `CDC is ${state}` });

    // 4. Advance the sequences. CDC copied the values, never the sequence positions.
    const sequences = await deps.advanceSequences();
    steps.push({
      name: "advance-sequences", ok: true,
      detail: sequences.map((s) => `${s.sequence} -> ${s.lastValue}`).join(", ") || "no serial columns",
    });

    // 5. Flip. Point the pool at the target and start accepting work again.
    await deps.flip();
    steps.push({ name: "flip", ok: true, detail: "application is now writing to the target" });

    await deps.setAcceptingStarts(true);
    return steps;
  } catch (error) {
    // Whatever went wrong, do not leave the platform quiesced. A refused cutover must
    // leave the system exactly as usable as it was before the button was pressed.
    await deps.setAcceptingStarts(true);
    throw error;
  }
}
