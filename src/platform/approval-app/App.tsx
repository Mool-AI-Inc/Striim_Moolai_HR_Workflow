/** @lifespan PRODUCTION — the reviewer console: employee picker + settable clock, onboarding journey, approval drill-down. */
import { useEffect, useState } from "react";
import {
  getJourney, getEmployees, runEmployee, advanceClock, postDecision, runScans,
  type Journey as JourneyData, type EmployeeOption, type ScanResult,
} from "./api.js";
import { Journey } from "./Journey.js";
import { ApprovalDetail } from "./ApprovalDetail.js";
import { Logo } from "./Logo.js";
import { MigrationPanel } from "./MigrationPanel.js";
import { SourceBadge } from "./SourceBadge.js";

type LoadState = "loading" | "ready" | "error";

export function App() {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [journey, setJourney] = useState<JourneyData | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [scans, setScans] = useState<ScanResult | null>(null);
  // Which HRIS the demo is presenting as the source. BambooHR is the one actually wired and
  // feeding this platform; Workday is where the data flows onward. The toggle drives the
  // logo in the header badge, so the two never disagree on screen.
  const [hrisWorkday, setHrisWorkday] = useState(false);
  const selectedHris = hrisWorkday ? "Workday" : "BambooHR";

  async function refresh(): Promise<void> {
    try { setJourney(await getJourney()); setLoad("ready"); } catch { setLoad("error"); }
  }
  async function refreshEmployees(): Promise<void> {
    try { setEmployees(await getEmployees()); } catch { /* surfaced via journey error */ }
  }

  useEffect(() => {
    void refreshEmployees();
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    // The roster is polled too, on a slower cycle.
    //
    // It used to be fetched once on mount, so a person added in BambooHR never appeared in this
    // dropdown until someone reloaded the page — and "just refresh the browser" is the moment a
    // live demo of a real-time pipeline stops being convincing. /employees re-reads the table on
    // every call, so this is one small query against ten rows. 10s rather than 3s because a new
    // hire has to clear Striim's five-minute reader floor first; polling faster buys nothing.
    const e = setInterval(() => void refreshEmployees(), 10_000);
    return () => { clearInterval(t); clearInterval(e); };
  }, []);

  async function onPick(id: string): Promise<void> {
    setPicked(id); setActiveKey(null);
    if (!id) return;
    setBusy(true);
    try { setJourney(await runEmployee(id)); } catch { setLoad("error"); } finally { setBusy(false); }
  }
  async function onAdvance(days: number): Promise<void> {
    setBusy(true);
    try { setJourney(await advanceClock(days)); } catch { setLoad("error"); } finally { setBusy(false); }
  }
  async function onRunScans(): Promise<void> {
    setBusy(true);
    try { setScans(await runScans()); } catch { setLoad("error"); } finally { setBusy(false); }
  }

  const activeApproval = journey?.steps.find((s) => s.key === activeKey)?.approval ?? null;
  const day = journey?.clock.day ?? 0;
  const hasRun = !!journey?.employee;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <Logo className="brand-logo" />
          <h1>Approvals</h1>
        </div>
        <SourceBadge selected={selectedHris} />
        {journey?.employee && (
          <div className="eyebrow"><span className="dot" aria-hidden="true" /><span className="label">{journey.employee.name} · new hire</span></div>
        )}
      </header>

      <div className="controls">
        <label className="picker">
          <span className="picker-label">New hire</span>
          <select value={picked} disabled={busy} onChange={(e) => void onPick(e.target.value)}>
            <option value="">Select an employee…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name} — {e.employeeType} · {e.costCenter}</option>
            ))}
          </select>
        </label>
        <div className="clock" aria-label="Demo clock">
          <span className="clock-day">Day {day}</span>
          <button type="button" className="btn-review" disabled={!hasRun || busy} onClick={() => void onAdvance(7)}>+7 days</button>
          <button type="button" className="btn-review" disabled={!hasRun || busy || day >= 60} onClick={() => void onAdvance(Math.max(1, 60 - day))}>Advance to Day 60 <span aria-hidden="true">›</span></button>
          {busy && <span className="clock-busy" role="status">working…</span>}
        </div>
        <div className="scans" aria-label="Recurring automations">
          <button type="button" className="btn-review" disabled={busy} onClick={() => void onRunScans()}>Run daily scans</button>
        </div>
        <div className="toggle">
          <span className="toggle-name" data-active={!hrisWorkday}>BambooHR</span>
          <button
            type="button"
            role="switch"
            aria-checked={hrisWorkday}
            aria-label="HRIS source: off is BambooHR, on is Workday"
            className="toggle-track"
            onClick={() => setHrisWorkday((v) => !v)}
          >
            <span className="toggle-knob" aria-hidden="true" />
          </button>
          <span className="toggle-name" data-active={hrisWorkday}>Workday</span>
        </div>
      </div>

      {scans && (
        <section className="scan-results" aria-label="Recurring automation results">
          <h2 className="pane-title">Recurring automations · {scans.scanToday}</h2>
          <ul className="scan-list">
            <li><span aria-hidden="true">🎂</span> Birthdays <span className="uc">UC5</span>: {scans.birthdays.length ? scans.birthdays.join(", ") : "none today"}</li>
            <li><span aria-hidden="true">🎉</span> Anniversaries <span className="uc">UC5</span>: {scans.anniversaries.length ? scans.anniversaries.join(", ") : "none today"}</li>
            <li><span aria-hidden="true">💬</span> Slack invites <span className="uc">UC8</span>: {scans.slackInvites.length ? scans.slackInvites.join(", ") : "none"}</li>
            <li><span aria-hidden="true">📊</span> Finance report <span className="uc">UC4</span>: {scans.financeReport
              ? <>{scans.financeReport.rowCount} hire(s), {scans.financeReport.transitionCount} transition(s) — {scans.financeReport.location
                  ? <a href={scans.financeReport.location} target="_blank" rel="noopener noreferrer">view report</a>
                  : "no link"}</>
              : "none"}</li>
          </ul>
        </section>
      )}

      <MigrationPanel />

      <main className="console">
        <aside className="journey-pane" aria-label="Onboarding journey">
          <h2 className="pane-title">Onboarding journey</h2>
          {load === "error" && (
            <div className="state state-error" role="alert">
              <p>Couldn’t reach the demo API.</p>
              <button type="button" className="btn btn-reject" onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {load !== "error" && !hasRun && (
            <div className="state state-idle"><p>Pick a new hire above to start their onboarding arc.</p></div>
          )}
          {hasRun && journey && <Journey steps={journey.steps} activeKey={activeKey} onReview={(s) => setActiveKey(s.key)} />}
        </aside>

        <section className="detail-pane" aria-label="Approval detail">
          {activeApproval ? (
            <ApprovalDetail
              key={activeApproval.id}
              approval={activeApproval}
              onDecide={async (d) => { await postDecision(activeApproval.id, d); await refresh(); setActiveKey(null); }}
            />
          ) : (
            <div className="state state-idle">
              <p>{hasRun ? "Select a decision to review the AI’s recommendation, then approve or reject with a reason." : "The reviewer’s decisions appear here once an arc is running."}</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
