/** @lifespan PRODUCTION — the reviewer's decision surface; WCAG 2.1 AA. */
import { useState } from "react";
import type { PendingApproval, ApprovalDecision } from "../domain/types.js";
import { KIND_LABEL } from "./ApprovalList.js";

type Decide = (d: Pick<ApprovalDecision, "approved" | "reason" | "selectedDocs">) => Promise<void>;

// Only render http(s) links — React does NOT sanitize href, so an untrusted `javascript:` URL would execute on click.
const safeHref = (v: unknown): string => { const s = String(v ?? "#"); return /^https?:\/\//i.test(s) ? s : "#"; };

function KindDetail({ approval }: { approval: PendingApproval }) {
  const d = approval.detail as Record<string, unknown>;
  switch (approval.kind) {
    case "packet-assignment": {
      const conf = typeof d.confidence === "number" ? d.confidence : null;
      const flags = (d.flags as string[] ?? []);
      return (
        <dl className="kv">
          <dt>Packet</dt><dd>{String(d.packetId)}{d.label ? ` — ${String(d.label)}` : ""}</dd>
          <dt>Employee</dt><dd>{String(d.employeeType ?? "?")} · {String(d.costCenter ?? "?")} · status {String(d.status ?? "?")}</dd>
          <dt>Rationale</dt><dd>{String(d.rationale)}</dd>
          {conf !== null && (
            <>
              <dt>Confidence</dt>
              <dd>
                <div className="confidence">
                  <div className="track"><div className="fill" style={{ width: `${Math.round(conf * 100)}%` }} /></div>
                  <span className="pct">{Math.round(conf * 100)}%</span>
                </div>
              </dd>
            </>
          )}
          <dt>Flags</dt>
          <dd>{flags.length ? <ul className="flags">{flags.map((f, i) => <li key={i}>{f}</li>)}</ul> : <span className="flags-none">None</span>}</dd>
        </dl>
      );
    }
    case "benefits-send":  return <p className="detail-note">Send benefits document: {String(d.doc ?? "benefits-summary.pdf")}</p>;
    case "finance-report": return <p className="detail-note"><a href={safeHref(d.location)} target="_blank" rel="noreferrer">Open finance report</a></p>;
    case "personnel-file": return <p className="detail-note">Checklist — arrived: {(d.arrived as string[] ?? []).join(", ") || "none"}; missing: {(d.missing as string[] ?? []).join(", ") || "none"}</p>;
  }
}

export function ApprovalDetail({ approval, onDecide }: { approval: PendingApproval; onDecide: Decide }) {
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const isPacket = approval.kind === "packet-assignment";
  const allDocs = isPacket ? ((approval.detail as Record<string, unknown>).requiredDocs as string[] ?? []) : [];
  const [selected, setSelected] = useState<string[]>(allDocs);   // all docs checked by default; state resets per item via key=id in App
  const toggle = (doc: string) => setSelected((s) => (s.includes(doc) ? s.filter((x) => x !== doc) : [...s, doc]));
  async function decide(approved: boolean) {
    try {
      await onDecide({ approved, reason, selectedDocs: isPacket ? selected : undefined });
      setStatus({ text: approved ? "Approved." : "Rejected.", tone: "ok" });
    } catch { setStatus({ text: "Could not record the decision — it may already be decided. Try reloading.", tone: "err" }); }
  }
  return (
    <div className="detail-card">
      <h2>{approval.title}</h2>
      <p className="detail-kind">
        <span className="badge" data-kind={approval.kind}>
          <span className="badge-dot" aria-hidden="true" />
          {KIND_LABEL[approval.kind]}
        </span>
      </p>
      <KindDetail approval={approval} />
      {isPacket && (
        <fieldset className="doc-picker">
          <legend>Documents to assign &amp; send</legend>
          {allDocs.map((doc) => (
            <label key={doc} className="doc-item">
              <input type="checkbox" checked={selected.includes(doc)} onChange={() => toggle(doc)} />
              <span>{doc}</span>
            </label>
          ))}
          <p className="doc-count" aria-live="polite">{selected.length} of {allDocs.length} selected</p>
        </fieldset>
      )}
      <div className="decide">
        <label htmlFor="reason">Reason (required)</label>
        <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you approving or rejecting?" />
        <div className="actions">
          <button type="button" className="btn btn-approve" onClick={() => decide(true)} disabled={!reason.trim() || (isPacket && selected.length === 0)}>
            Approve <span aria-hidden="true">›</span>
          </button>
          <button type="button" className="btn btn-reject" onClick={() => decide(false)} disabled={!reason.trim()}>Reject</button>
        </div>
        <p className="status" role="status" aria-live="polite" data-tone={status?.tone}>{status?.text ?? ""}</p>
      </div>
    </div>
  );
}
