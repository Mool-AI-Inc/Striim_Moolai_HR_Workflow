/** @lifespan PRODUCTION — the line mark beside each integration category.
 *
 * One glyph per connector category, drawn on a 24-grid with a 1.6 stroke so they sit
 * evenly beside 16px type. Stroke is currentColor, so the category tint drives the colour
 * rather than each icon hard-coding one.
 *
 * These say what the category DOES — a payslip, an envelope, a shield — not which vendor
 * fills it. The vendor's own mark lives in the picker below. Decorative: every icon is
 * aria-hidden and the category name is always rendered as text beside it.
 */

const PATHS: Record<string, React.JSX.Element> = {
  // HRIS / payroll — a payslip with a row of figures
  hris: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h4" />
    </>
  ),
  // Transactional email — envelope
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7.5l9 6 9-6" />
    </>
  ),
  // SMS — message bubble with a tail
  sms: (
    <>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z" />
      <path d="M9 12h6" />
    </>
  ),
  // Team chat — two overlapping bubbles
  chat: (
    <>
      <path d="M15 4h4a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v3l-3-3" />
      <path d="M13 4H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h1v3l3-3h2" />
    </>
  ),
  // Background screening — shield with a check
  screening: (
    <>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8-7 9.5-4.1-1.5-7-5.2-7-9.5V6l7-3Z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  // Onboarding documents — a form with a signature line
  onbdocs: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M8 16c1.5-1.5 2.5 1 4 0s2.5-1.5 4 0" />
    </>
  ),
  // Benefits — heart inside a frame, the enrolment packet
  benefits: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M12 16s-3-2-3-4a1.8 1.8 0 0 1 3-1.2A1.8 1.8 0 0 1 15 12c0 2-3 4-3 4Z" />
    </>
  ),
  // Document storage — folder
  storage: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </>
  ),
  // Reporting — a table with a header row
  reporting: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11M15 9v11" />
    </>
  ),
  // RPA — a robot head; the thing that drives a portal with no API
  rpa: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5" />
    </>
  ),
  // AI — a four-point spark
  ai: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </>
  ),
};

export function CategoryIcon({ category, size = 20 }: { category: string; size?: number }) {
  const path = PATHS[category];
  if (!path) return null;      // an unknown category simply gets no mark, never a broken one
  return (
    <svg
      className="cfg-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}
