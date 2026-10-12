/** @lifespan PRODUCTION — says which HRIS this platform is actually reading.
 *
 * The stack picker on the gate screen is cosmetic: it lets a reviewer select "Paylocity"
 * while the live feed is BambooHR. That is acceptable in a configurator and misleading
 * everywhere else, so this reports the truth — which system the employees in the database
 * came from, how many arrived, and when the last one landed.
 *
 * It names the source of RECORD, which is a different thing from the ledger. The HRIS says
 * who works here and we only ever read it; the ledger says what we already did about them
 * and it is ours alone. Conflating the two is how people end up thinking a re-fetchable
 * mirror and an irreplaceable audit trail carry the same risk.
 */
import { useEffect, useState } from "react";
import { VendorIcon } from "./VendorIcon.js";
import { getHrisStatus, type HrisStatus } from "./api.js";

/** "12s ago" / "4m ago" — relative beats a timestamp for a freshness signal. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/** `selected` comes from the toggle in the controls row, so the logo on top always matches
 *  what the operator has switched to. */
export function SourceBadge({ selected }: { selected: string }): React.JSX.Element | null {
  const [status, setStatus] = useState<HrisStatus | null>(null);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try { setStatus(await getHrisStatus()); } catch { /* transient; the poll retries */ }
    };
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, []);

  if (!status) return null;

  // The toggle flips the DIRECTION of the migration, not just the source label:
  //   BambooHR selected  ->  BambooHR  →  Workday
  //   Workday  selected  ->  Workday   →  BambooHR
  // The destination is simply the other end, so the two can never both show the same system.
  const target = selected === "Workday" ? "BambooHR" : "Workday";
  const dest = status.destination;
  // Both directions now have a real writer, so neither says "not wired" any more — that line was
  // written before the BambooHR leg existed and is simply false now: the reverse pipeline creates
  // employees in the live tenant through BambooHRClient, verified end to end.
  //
  //   Workday  -> Adaptive Planning, writes into pre-allocated EmpID_EUPTD members
  //   BambooHR -> BambooHRClient.createEmployee, creates a real (permanent) employee
  const targetDetail = target === "Workday"
    ? (dest.ready ? dest.mode : "Workday Adaptive — credentials not configured")
    : "BambooHR — creates a real employee (permanent)";
  // Emphasis only: the border firms up when the toggled system is the one actually feeding
  // the database. No text depends on this, so a mismatch reads as "less emphasised" rather
  // than as an error.
  const isLive = status.connected && status.label.toLowerCase().startsWith(selected.toLowerCase());

  return (
    <div className="flow-badge">
      <div className="source-badge" data-connected={isLive}>
        <span className="source-mark" aria-hidden="true">
          <VendorIcon vendor={selected} size={18} />
        </span>
        <span className="source-text">
          {/* "Source of record" not "HRIS" — it says what the thing IS to a reviewer. */}
          <span className="source-label">Source of record</span>
          <span className="source-name">{selected}</span>
          {/* Describes the PLATFORM's state, not the connection's. 112 employees really are
              loaded and really were synced when it says so, whichever system the toggle
              names — so there is no claim here that can be false. Saying "not connected"
              made a working demo look broken; saying "live" for an unwired system would
              have been untrue. This says neither. */}
          {/* TWO numbers, because one of them invites a contradiction on screen.
              `employees` counts public.employees, which mirrors BambooHR's custom REPORT —
              everyone on the account, including the 18 who are inactive. BambooHR's own UI
              shows the DIRECTORY, which hides those. So this badge read 112 while the HRIS
              open beside it read 91, and the honest reading is not "one is wrong" but "they
              answer different questions". `landingRows` is the directory figure exactly,
              because the directory is what Striim's reader mirrors. */}
          <span className="source-detail">
            {status.employees > 0
              ? `${status.landingRows} in directory · ${status.employees} on account`
                + ` · synced ${ago(status.lastSyncedAt)}`
              : (status.reason ?? "no employees loaded")}
          </span>
        </span>
      </div>

      <span className="flow-arrow" aria-hidden="true">→</span>

      <div className="source-badge" data-connected={target === "Workday" && dest.ready}>
        <span className="source-mark" aria-hidden="true">
          <VendorIcon vendor={target} size={18} />
        </span>
        <span className="source-text">
          <span className="source-label">Migrates to</span>
          <span className="source-name">{target}</span>
          <span className="source-detail">{targetDetail}</span>
        </span>
      </div>
    </div>
  );
}
