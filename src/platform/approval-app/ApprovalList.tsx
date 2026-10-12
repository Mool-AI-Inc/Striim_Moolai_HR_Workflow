/** @lifespan PRODUCTION — semantic list of pending approvals; each item a real button (WCAG 2.1 AA). */
import type { PendingApproval } from "../domain/types.js";

export const KIND_LABEL: Record<PendingApproval["kind"], string> = {
  "packet-assignment": "Onboarding packet",
  "benefits-send": "Benefits send",
  "finance-report": "Finance report",
  "personnel-file": "Personnel file",
};

export function ApprovalList({ items, selectedId, onSelect }: {
  items: PendingApproval[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  return (
    <ul className="inbox">
      {items.map((p) => (
        <li className="inbox-item" key={p.id}>
          <button type="button" aria-current={p.id === selectedId} onClick={() => onSelect(p.id)}>
            <span className="badge" data-kind={p.kind}>
              <span className="badge-dot" aria-hidden="true" />
              {KIND_LABEL[p.kind]}
            </span>
            <span className="item-title">{p.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
