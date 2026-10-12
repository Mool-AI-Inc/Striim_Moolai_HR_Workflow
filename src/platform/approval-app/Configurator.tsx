/** @lifespan PRODUCTION — the pre-demo "connect your stack" gate, laid out as the arc of
 *  one new hire rather than a settings grid.
 *
 *  The argument this screen makes: these integrations are not a checklist, they are a
 *  SEQUENCE. Each plugs in at a specific moment in an employee's first sixty days, and
 *  showing them in that order tells a reviewer *why* each vendor is here — which a flat
 *  alphabetised grid never does. The day markers down the left are the spine; the vendor
 *  pickers hang off the moment they are actually used.
 *
 *  COSMETIC ONLY — selections drive nothing and no real connection is made; options[0] in
 *  each list is the vendor actually wired in the code. Launch reveals today's console.
 */
import { Logo } from "./Logo.js";
import { useState } from "react";
import { VendorSelect } from "./VendorSelect.js";
import { CategoryIcon } from "./CategoryIcon.js";

interface Category {
  key: string;
  label: string;
  hint: string;              // what the platform does with it
  options: string[];         // options[0] is the planned/default vendor
  illustrative?: boolean;    // category is real in the code but no vendor was pinned
}

interface Stage {
  when: string;              // the day marker — the spine of the page
  day: number;               // where it sits on the 0-75 rail; uneven ON PURPOSE
  gate: "agent" | "human";   // does it complete itself, or stop and wait for a person
  title: string;
  blurb: string;
  uc: string;                // which use cases fire here, so the arc maps to real code
  categories: Category[];
}

// Every category is a real connector port (src/platform/connectors/, config/env.ts).
// Stages follow the order the workflows actually run in.
const STAGES: Stage[] = [
  {
    when: "Day 0",
    day: 0, gate: "agent",
    title: "A hire lands in payroll",
    blurb: "Someone is hired in the HR system. That webhook is the only thing that starts any of this.",
    uc: "the trigger",
    categories: [
      // BambooHR leads because it is the system actually wired and feeding this platform —
      // see the source-of-record badge in the header. Paylocity remains an option because the
      // committed simulator still speaks its shape.
      { key: "hris", label: "HRIS / Payroll", hint: "Reads employee records; stages new hires", options: ["BambooHR", "Workday", "Paylocity", "Rippling"] },
    ],
  },
  {
    when: "Day 0",
    day: 1, gate: "agent",
    title: "Say hello",
    blurb: "A welcome email goes out, and a text if — and only if — they consented to one.",
    uc: "UC1 · UC7",
    categories: [
      // env.ts pins Postmark for PLATFORM_MODE=live; the interactive demo sends via Graph.
      { key: "email", label: "Transactional email", hint: "Welcome, Day-60, birthday & report mail", options: ["Postmark", "Microsoft 365 (Graph)", "SendGrid"] },
      // AcSmsConnector is ActiveCampaign, documented in-file as the real send path.
      { key: "sms", label: "SMS", hint: "Consent-gated welcome text", options: ["ActiveCampaign", "Twilio", "Vonage"] },
    ],
  },
  {
    when: "Before they start",
    day: 3, gate: "agent",
    title: "Put them on the team",
    blurb: "A daily scan finds who starts tomorrow and invites them to the right channels.",
    uc: "UC8",
    categories: [
      { key: "chat", label: "Team chat", hint: "Auto-invite once a hire starts", options: ["Slack", "Microsoft Teams"] },
    ],
  },
  {
    when: "First week",
    day: 7, gate: "human",
    title: "Clear the paperwork",
    blurb: "Background check and I-9 come back, and the personnel file is assembled and filed.",
    uc: "UC3 · needs approval",
    categories: [
      { key: "screening", label: "Background screening", hint: "Pulls the completed check", options: ["Vetty", "Checkr", "Sterling"] },
      { key: "onbdocs", label: "Onboarding documents (I-9)", hint: "Retrieves submitted forms", options: ["WorkBright", "DocuSign", "Dropbox Sign"] },
      { key: "storage", label: "Document storage", hint: "Files the personnel packet", options: ["Google Drive", "SharePoint", "Box"] },
    ],
  },
  {
    when: "First week",
    day: 10, gate: "human",
    title: "Kit them out",
    blurb: "The model reads their role and cost centre and recommends a packet. A human signs it off before anything is assigned.",
    uc: "UC6 · needs approval",
    categories: [
      { key: "ai", label: "AI packet recommendation", hint: "Recommends the onboarding packet", options: ["Claude (Anthropic)", "Rules-only"] },
      // The README names Playwright as the production robot runner; both RPA paths
      // currently go through a file-drop connector, so the category stays illustrative.
      { key: "rpa", label: "RPA automation runner", hint: "Drives legacy portals with no API", options: ["Playwright", "UiPath", "Power Automate"], illustrative: true },
    ],
  },
  {
    when: "Day 60",
    day: 60, gate: "human",
    title: "Benefits and compliance",
    blurb: "A durable timer set on day zero matures. The compliance notice sends itself; the benefits hand-off waits for a person.",
    uc: "UC2a · UC2b · needs approval",
    categories: [
      { key: "benefits", label: "Benefits administration", hint: "Day-60 benefits enrollment send", options: ["Employee Navigator", "bswift", "Ease"] },
    ],
  },
  {
    when: "Every month",
    day: 72, gate: "human",
    title: "Tell finance",
    blurb: "New hires and cost-centre transitions, totted up and sent for sign-off.",
    uc: "UC4 · needs approval",
    categories: [
      { key: "reporting", label: "Reporting / spreadsheet", hint: "Monthly finance report sink", options: ["Google Sheets", "Excel Online"] },
    ],
  },
];

const ALL = STAGES.flatMap((s) => s.categories);

export function Configurator({ onLaunch }: { onLaunch: () => void }) {
  // Pre-select the planned vendor for every category (demo-friendly: hit Launch, or change picks live).
  const [choices, setChoices] = useState<Record<string, string>>(
    () => Object.fromEntries(ALL.map((c) => [c.key, c.options[0]])),
  );
  const connected = ALL.filter((c) => choices[c.key]).length;
  const total = ALL.length;
  const ready = connected === total;

  return (
    <div className="configurator">
      <header className="cfg-header">
        <Logo className="brand-logo" />
        <span className="cfg-product">HR Workflow</span>
      </header>

      <h1 className="cfg-title">A new hire&rsquo;s first sixty days, run by agents</h1>
      <p className="cfg-lead">
        Nine workflows, each firing at its own moment. Pick the system you use at each step —
        the arc below is the order they actually run in.
      </p>

      <ol className="cfg-journey">
        {STAGES.map((stage, i) => (
          <li
            className={`cfg-stage${stage.gate === "human" ? " is-gate" : ""}`}
            key={`${stage.when}-${stage.title}`}
          >
            <div className="cfg-spine" aria-hidden="true">
              <span className="cfg-step-n">{String(i + 1).padStart(2, "0")}</span>
              <span className="cfg-rail" />
            </div>

            <div className="cfg-stage-body">
              <div className="cfg-stage-head">
                <span className="cfg-when">{stage.when}</span>
                <h2 className="cfg-stage-title">{stage.title}</h2>
                <p className="cfg-blurb">{stage.blurb}</p>
                <span className="cfg-badges">
                  <span className={`cfg-gate cfg-gate-${stage.gate}`}>
                    {stage.gate === "human" ? "stops for a person" : "runs on its own"}
                  </span>
                  <span className="cfg-uc">{stage.uc}</span>
                </span>
              </div>

              <div className="cfg-grid">
                {stage.categories.map((cat) => (
                  <div className="cfg-card" key={cat.key}>
                    <div className="cfg-head">
                      <span className="cfg-icon-wrap" aria-hidden="true"><CategoryIcon category={cat.key} /></span>
                      <div className="cfg-titles">
                        <span className="cfg-cat">{cat.label}</span>
                        <span className="cfg-hint">{cat.hint}</span>
                      </div>
                    </div>
                    <VendorSelect
                      label={`${cat.label} vendor`}
                      value={choices[cat.key]}
                      options={cat.options}
                      onChange={(v) => setChoices((c) => ({ ...c, [cat.key]: v }))}
                    />
                    <div className="cfg-row-foot">
                      <span className="cfg-conn"><span className="dot" aria-hidden="true" /> Connected</span>
                      {cat.illustrative && <span className="cfg-note">illustrative — not pinned in the plan</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {/* The two data-integration pipelines are their own processes on their own ports, so these
          are links rather than routes. `?launched=1` skips their own landing gate — arriving from
          here IS the launch, and a second identical gate would just be a click to dismiss.
          Opened in a new tab because a demo usually wants both side by side, and losing this page
          to a back button mid-presentation is worse than an extra tab. */}
      <div className="cfg-pipelines">
        <span className="cfg-pipelines-label">Data integration pipelines</span>
        <a className="btn" href="http://localhost:3000/?launched=1" target="_blank" rel="noreferrer">
          BambooHR → Striim → PostgreSQL → Workday <span aria-hidden="true">›</span>
        </a>
        <a className="btn" href="http://localhost:3001/?launched=1" target="_blank" rel="noreferrer">
          Workday → Striim → PostgreSQL → BambooHR <span aria-hidden="true">›</span>
        </a>
      </div>

      <div className="cfg-footer">
        <p className="cfg-count"><span className="dot" aria-hidden="true" />{connected} of {total} integrations connected</p>
        <button type="button" className="btn btn-approve" disabled={!ready} onClick={onLaunch}>
          Launch <span aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  );
}
