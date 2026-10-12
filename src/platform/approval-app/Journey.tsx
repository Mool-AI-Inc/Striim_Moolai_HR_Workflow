/** @lifespan PRODUCTION — the onboarding journey: automated steps as receipts, human approvals as actionable cards. */
import type { JourneyStep } from "./api.js";

function icon(status: JourneyStep["status"]): string {
  if (status === "done" || status === "approved") return "✓";
  if (status === "rejected" || status === "expired") return "✕";
  return "•";
}
function autoTail(status: JourneyStep["status"]): string {
  if (status === "done") return "Sent";
  if (status === "scheduled") return "Scheduled";
  return "Pending";
}

export function Journey({ steps, activeKey, onReview }: {
  steps: JourneyStep[]; activeKey: string | null; onReview: (step: JourneyStep) => void;
}) {
  return (
    <ol className="journey">
      {steps.map((s) => (
        <li key={s.key} className={`journey-step step-${s.kind}`} data-status={s.status}>
          <span className="step-icon" aria-hidden="true">{icon(s.status)}</span>
          <div className="step-body">
            <p className="step-label">{s.label}</p>
            {s.summary && <p className="step-summary">{s.summary}</p>}
            {s.note && s.kind === "auto" && <p className="step-note">{s.note}</p>}
          </div>
          <div className="step-tail">
            {s.kind === "auto" && <span className="step-status">{autoTail(s.status)}</span>}
            {s.kind === "approval" && s.status === "pending" && (
              <button type="button" className="btn-review" aria-current={s.key === activeKey} onClick={() => onReview(s)}>
                Review <span aria-hidden="true">›</span>
              </button>
            )}
            {s.kind === "approval" && (s.status === "approved" || s.status === "rejected" || s.status === "expired") && (
              <span className={`pill pill-${s.status}`}>{s.status}</span>
            )}
            {s.kind === "approval" && s.status === "waiting" && <span className="step-status">Preparing…</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
