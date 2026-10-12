/** @lifespan PRODUCTION — the operator's migration controls: two databases, four buttons.
 *
 * The buttons appear in the order they are meant to be pressed, and each one that is
 * disabled says WHY in text rather than being greyed out and inert. WCAG 2.1 AA: real
 * button elements, aria-live on the status region so a screen reader hears row counts and
 * cutover progress change, and no state signalled by colour alone — every marker carries
 * a word or a glyph as well.
 */
import { useCallback, useEffect, useState } from "react";
import {
  getMigrationStatus, startCdc, startInitialLoad, runCutover, runReconcile, resetMigration,
  type MigrationStatus, type MigrationActionResult, type TableComparison,
} from "./api.js";

type Busy = null | "cdc" | "load" | "cutover" | "reconcile" | "reset";
type Ready = Extract<MigrationStatus, { configured: true }>;

/** Why the initial-load button cannot be pressed, or null when it can. */
function loadBlockedReason(s: Ready): string | null {
  if (!s.slot.exists) return "the replication slot does not exist yet — start CDC first";
  // Deliberately NOT gated on cdcState === RUNNING. The application reports RUNNING about
  // fifteen seconds before the slot is actually held, and a bulk load started inside that
  // window loses every write that lands in it, with no error anywhere on the platform.
  if (!s.slotReady) return "waiting for Striim to actually hold the slot (the app reports RUNNING first)";
  return null;
}

function cutoverBlockedReason(s: Ready): string | null {
  if (s.writingTo === "target") return "already cut over";
  if (!s.tables.length) return "no table counts yet";
  if (!s.tables.every((t) => t.match)) {
    return "source and target do not match yet — the drain will block until they do";
  }
  return null;
}

export function MigrationPanel(): React.JSX.Element {
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await getMigrationStatus()); } catch { /* transient; the poll retries */ }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(which: Busy, fn: () => Promise<MigrationActionResult>, done: string): Promise<void> {
    setBusy(which); setMessage(null);
    try {
      const r = await fn();
      setMessage(r.ok ? done : `Refused${r.refusedAt ? ` at ${r.refusedAt}` : ""}: ${r.reason ?? "no reason given"}`);
    } catch (e) {
      setMessage(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  if (!status) return <section className="migration-panel"><p>Loading migration status…</p></section>;

  if (!status.configured) {
    return (
      <section className="migration-panel" aria-label="Database migration">
        <h2 className="pane-title">Database migration</h2>
        <p className="migration-off">{status.reason}</p>
      </section>
    );
  }

  const loadBlocked = loadBlockedReason(status);
  const cutBlocked = cutoverBlockedReason(status);
  const anyBusy = busy !== null;

  return (
    <section className="migration-panel" aria-label="Database migration">
      <h2 className="pane-title">Database migration · Striim CDC</h2>

      <div className="migration-dbs">
        <DbCard title="Source" label={status.sourceUrlLabel} live={status.writingTo === "source"}
                tables={status.tables} pick={(t) => t.source.rows} />
        <div className="migration-arrow" aria-hidden="true">→</div>
        <DbCard title="Target" label={status.targetUrlLabel} live={status.writingTo === "target"}
                tables={status.tables} pick={(t) => t.target.rows} />
      </div>

      <dl className="migration-facts">
        <div><dt>CDC application</dt><dd>{status.cdcState}</dd></div>
        <div><dt>Initial load</dt><dd>{status.loadState}</dd></div>
        <div>
          <dt>Replication slot</dt>
          <dd>
            {status.slot.exists
              ? `${status.slot.name} · ${status.slot.plugin ?? "?"} · ${status.slot.active ? "held" : "not held right now"}`
              : "not created"}
          </dd>
        </div>
        <div><dt>Accepting new workflows</dt><dd>{status.acceptingStarts ? "yes" : "no — quiesced"}</dd></div>
      </dl>

      <div className="migration-actions">
        <button type="button" className="btn-review" disabled={anyBusy}
                onClick={() => void act("cdc", startCdc, "CDC started and the slot is created.")}>
          1 · Start CDC
        </button>
        <button type="button" className="btn-review" disabled={anyBusy || loadBlocked !== null}
                onClick={() => void act("load", startInitialLoad, "Initial load started.")}>
          2 · Run initial load
        </button>
        <button type="button" className="btn-review" disabled={anyBusy}
                onClick={() => void act("reconcile", runReconcile, "Reconciled — counts and checksums compared.")}>
          Reconcile
        </button>
        <button type="button" className="btn-review" disabled={anyBusy || cutBlocked !== null}
                onClick={() => void act("cutover", runCutover, "Cut over. The application is now writing to the target.")}>
          3 · Cut over
        </button>
        <button type="button" className="btn-reject" disabled={anyBusy}
                onClick={() => void act("reset", resetMigration, "Reset — target truncated, slot dropped, apps stopped.")}>
          Reset
        </button>
      </div>

      {/* A disabled button that does not say why is just a broken button. */}
      {loadBlocked && <p className="migration-why">Initial load unavailable: {loadBlocked}</p>}
      {cutBlocked && <p className="migration-why">Cut over unavailable: {cutBlocked}</p>}

      <div className="migration-status" role="status" aria-live="polite">
        {busy && <p>Working on {busy}…</p>}
        {message && <p>{message}</p>}
        {status.lastError && <p className="migration-error">Last error: {status.lastError}</p>}
        {status.lastCutover && (
          <ol className="migration-steps">
            {status.lastCutover.map((s) => (
              <li key={s.name}>
                <span aria-hidden="true">{s.ok ? "✓" : "✗"}</span>{" "}
                <strong>{s.name}</strong>{s.detail ? ` — ${s.detail}` : ""}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function DbCard(props: {
  title: string; label: string; live: boolean;
  tables: TableComparison[]; pick: (t: TableComparison) => number;
}): React.JSX.Element {
  const { title, label, live, tables, pick } = props;
  return (
    <div className="migration-db" data-live={live}>
      <h3>
        {title}
        {/* the word carries the meaning, not just the colour */}
        {live && <span className="migration-live"> · live — the app is writing here</span>}
      </h3>
      <p className="migration-host">{label}</p>
      <table className="migration-counts">
        <caption className="visually-hidden">Row counts per table on the {title.toLowerCase()} database</caption>
        <thead><tr><th scope="col">Table</th><th scope="col">Rows</th></tr></thead>
        <tbody>
          {tables.length === 0 && <tr><td colSpan={2}>no counts yet</td></tr>}
          {tables.map((t) => (
            <tr key={t.table}>
              <th scope="row">{t.table}</th>
              <td>{pick(t)}{t.match ? "" : " *"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tables.some((t) => !t.match) && <p className="migration-note">* differs from the other side</p>}
    </div>
  );
}
