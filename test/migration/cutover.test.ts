/** @lifespan THROWAWAY — unit tier; every dependency injected, no Striim and no Postgres.
 *
 * The refusals are what is being tested. Order is what makes a cutover safe, and a cutover
 * that proceeds in the wrong order fails silently — so every one of these asserts that
 * something did NOT happen.
 */
import { describe, it, expect, vi } from "vitest";
import { cutover, CutoverRefused, type CutoverDeps } from "../../src/platform/migration/cutover.js";
import type { TableComparison } from "../../src/platform/migration/reconcile.js";

const matched: TableComparison[] = [{
  table: "send_ledger",
  source: { table: "send_ledger", rows: 2, checksum: "a" },
  target: { table: "send_ledger", rows: 2, checksum: "a" },
  match: true,
}];

const drifted: TableComparison[] = [{
  table: "send_ledger",
  source: { table: "send_ledger", rows: 3, checksum: "a" },
  target: { table: "send_ledger", rows: 2, checksum: "b" },
  match: false,
}];

function deps(over: Partial<CutoverDeps> = {}): CutoverDeps {
  return {
    setAcceptingStarts: vi.fn(),
    reconcile: vi.fn(async () => matched),
    cdcState: vi.fn(async () => "STOPPED"),
    stopCdc: vi.fn(async () => {}),
    advanceSequences: vi.fn(async () => [{
      table: "send_ledger", column: "id", sequence: "public.send_ledger_id_seq", lastValue: 2,
    }]),
    flip: vi.fn(async () => {}),
    ...over,
  };
}

const OPTS = { drainTimeoutMs: 1000, pollMs: 10 };

describe("cutover", () => {
  it("runs the five steps in order and ends on the target", async () => {
    const d = deps();
    const steps = await cutover(d, OPTS);
    expect(steps.map((s) => s.name)).toEqual(["quiesce", "drain", "stop-cdc", "advance-sequences", "flip"]);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(d.setAcceptingStarts).toHaveBeenNthCalledWith(1, false);
    expect(d.setAcceptingStarts).toHaveBeenLastCalledWith(true);
  });

  it("stops CDC before flipping, never after", async () => {
    const order: string[] = [];
    const d = deps({
      stopCdc: vi.fn(async () => { order.push("stop"); }),
      flip: vi.fn(async () => { order.push("flip"); }),
    });
    await cutover(d, OPTS);
    expect(order).toEqual(["stop", "flip"]);
  });

  it("advances the sequences before flipping", async () => {
    const order: string[] = [];
    const d = deps({
      advanceSequences: vi.fn(async () => { order.push("setval"); return []; }),
      flip: vi.fn(async () => { order.push("flip"); }),
    });
    await cutover(d, OPTS);
    expect(order).toEqual(["setval", "flip"]);
  });

  it("refuses to flip when CDC is still running after the stop", async () => {
    const d = deps({ cdcState: vi.fn(async () => "RUNNING") });
    await expect(cutover(d, OPTS)).rejects.toThrow(CutoverRefused);
    expect(d.flip).not.toHaveBeenCalled();
  });

  it("treats an unknown CDC state as running — it does not flip on a shrug", async () => {
    const d = deps({ cdcState: vi.fn(async () => "UNKNOWN") });
    await expect(cutover(d, OPTS)).rejects.toThrow(CutoverRefused);
    expect(d.flip).not.toHaveBeenCalled();
  });

  it("refuses when the drain never converges, and never stops CDC or flips", async () => {
    const d = deps({ reconcile: vi.fn(async () => drifted) });
    await expect(cutover(d, { drainTimeoutMs: 60, pollMs: 10 })).rejects.toThrow(/drain/i);
    expect(d.stopCdc).not.toHaveBeenCalled();
    expect(d.flip).not.toHaveBeenCalled();
  });

  it("re-opens workflow starts even when it refuses", async () => {
    // A refused cutover must leave the platform exactly as usable as it was before the
    // button was pressed. Leaving it quiesced would be an outage caused by a safety check.
    const d = deps({ reconcile: vi.fn(async () => drifted) });
    await expect(cutover(d, { drainTimeoutMs: 60, pollMs: 10 })).rejects.toThrow();
    expect(d.setAcceptingStarts).toHaveBeenLastCalledWith(true);
  });

  it("waits for a drain that converges late rather than giving up at the first look", async () => {
    let calls = 0;
    const d = deps({ reconcile: vi.fn(async () => (++calls < 3 ? drifted : matched)) });
    const steps = await cutover(d, OPTS);
    expect(steps.find((s) => s.name === "drain")?.ok).toBe(true);
    expect(d.flip).toHaveBeenCalled();
  });
});
