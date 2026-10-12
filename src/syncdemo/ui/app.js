/* Dashboard client.
 *
 * ONE RULE: this file renders server state and never invents it.
 *
 * Every status shown comes from GET /api/snapshot, which reads Postgres. The SSE stream carries
 * notifications, not truth — when one arrives the client re-fetches the snapshot (coalesced) and
 * re-renders. There is no client-side timer that advances a stage, no optimistic "probably synced
 * by now", and no animation that runs on a schedule. If the pipeline stalls, the dashboard stalls
 * with it, which is the entire point of the exercise.
 */

const STAGES = [
  { key: "bamboohr",  title: "BambooHR",   icon: "1", note: "Source system" },
  { key: "striim",    title: "Striim",     icon: "2", note: "Change detection + transform" },
  { key: "postgres",  title: "PostgreSQL", icon: "3", note: "Intermediate database" },
  { key: "workday",   title: "Workday",    icon: "4", note: "Target system" },
];
const CONNECTOR_LABELS = ["real-time event", "stream", "sync"];

let snapshot = null;
let focusId = null;        // which employee the pipeline panel follows; null = newest
let userPickedFocus = false;
let renderedEventIds = new Set();

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const esc = (s) => String(s ?? "");
const hhmmss = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : "--:--:--");
const ago = (iso) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

// ── fetching ────────────────────────────────────────────────────────────────────────────

let fetchPending = false;
let fetchQueued = false;

async function refresh() {
  // Bursts are normal: one created employee produces a dozen notifications in a second. Coalesce
  // them into at most one in-flight request plus one queued, so the browser is not doing more
  // work than the pipeline it is watching.
  if (fetchPending) { fetchQueued = true; return; }
  fetchPending = true;
  try {
    const r = await fetch("/api/snapshot");
    if (!r.ok) throw new Error(`snapshot ${r.status}`);
    snapshot = await r.json();
    render();
  } catch (e) {
    console.error("snapshot failed", e);
  } finally {
    fetchPending = false;
    if (fetchQueued) { fetchQueued = false; void refresh(); }
  }
}

// ── SSE ─────────────────────────────────────────────────────────────────────────────────

function connect() {
  const es = new EventSource("/api/stream");
  const dot = $("#connDot");

  es.onopen = () => {
    dot.className = "conn on";
    dot.querySelector(".conn-label").textContent = "live";
  };
  es.onerror = () => {
    dot.className = "conn off";
    // EventSource reconnects by itself; saying "reconnecting" is honest about what is happening.
    dot.querySelector(".conn-label").textContent = "reconnecting";
  };
  es.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === "reset") { focusId = null; userPickedFocus = false; renderedEventIds = new Set(); }
    // A stage message names the employee that moved. Follow it unless the viewer chose someone.
    if (msg.type === "stage" && !userPickedFocus) focusId = msg.employeeId;
    void refresh();
  };
}

// ── rendering ───────────────────────────────────────────────────────────────────────────

const LANDING_STAGES = [
  { key: "bamboohr", role: "Source of truth" },
  { key: "striim",   role: "Change data capture" },
  { key: "postgres", role: "Intermediate database" },
  { key: "workday",  role: "Downstream target" },
];

function render() {
  if (!snapshot) return;
  renderLanding();
  renderBadges();
  renderCards();
  renderFocusPicker();
  renderPipeline();
  renderLog();
  renderSlots();
  renderTable();
  syncFaultToggles();
}

function renderBadges() {
  const wrap = $("#modeBadges");
  wrap.replaceChildren();
  const s = snapshot.config.systems;
  for (const [key, label] of [["bamboohr", "BambooHR"], ["striim", "Striim"], ["postgres", "Postgres"], ["workday", "Workday"]]) {
    const v = s[key];
    const b = el("span", `badge ${v.mode}`, `${label} ${v.mode}`);
    b.title = v.reason ? `${v.target} — ${v.reason}` : String(v.target ?? "");
    wrap.append(b);
  }
}

function card({ name, mode, metric, metricLabel, ok, rows }) {
  const c = el("div", `card ${ok === false ? "bad" : ok === true ? "ok" : ""}`);
  const head = el("div", "card-head");
  head.append(el("span", "card-name", name), el("span", `badge ${mode}`, mode));
  const m = el("div", "card-metric");
  m.append(document.createTextNode(metric === -1 ? "—" : String(metric)));
  m.append(el("small", null, ` ${metricLabel}`));
  const dl = el("dl", "kv");
  for (const [k, v, mono] of rows) {
    if (v === undefined || v === null || v === "") continue;
    const row = el("div");
    row.append(el("dt", null, k), el("dd", mono ? "mono" : null, String(v)));
    dl.append(row);
  }
  c.append(head, m, dl);
  return c;
}

function renderCards() {
  const s = snapshot.systems;
  const wrap = $("#cards");
  wrap.replaceChildren();

  wrap.append(card({
    name: "BambooHR", mode: s.bamboohr.mode, metric: s.bamboohr.count, metricLabel: "employees",
    ok: s.bamboohr.health.ok,
    rows: [
      ["Connection", s.bamboohr.health.ok ? "connected" : "unreachable"],
      ["Latest", s.bamboohr.latest, true],
      ["Last event", s.bamboohr.lastEvent],
      ["Detail", s.bamboohr.health.detail],
    ],
  }));

  wrap.append(card({
    name: "Striim", mode: s.striim.mode, metric: s.striim.eventsProcessed, metricLabel: "events processed",
    ok: s.striim.health.ok,
    rows: [
      ["Pipeline", s.striim.pipelineState],
      ["Processing", s.striim.activity],
      ["Last event", s.striim.lastEvent],
      ["Landed", `${s.striim.landed} rows in the landing table`],
    ],
  }));

  wrap.append(card({
    name: "PostgreSQL", mode: "live", metric: s.postgres.count, metricLabel: "employees",
    ok: s.postgres.health.ok,
    rows: [
      ["Connection", s.postgres.health.ok ? "connected" : "unreachable"],
      ["Database", s.postgres.health.detail, true],
      ["Latest", s.postgres.latest, true],
      ["Last update", ago(s.postgres.lastUpdate)],
    ],
  }));

  wrap.append(card({
    name: "Workday", mode: s.workday.mode,
    metric: s.workday.count,
    // Precise wording in live mode. Adaptive's sheet also holds rows written by the Slack agent
    // on the same instance, so this number is what THIS pipeline put there, not the sheet size.
    metricLabel: s.workday.mode === "live" ? "synced by this pipeline" : "workers",
    ok: s.workday.health.ok,
    rows: [
      ["Connection", s.workday.health.ok ? "connected" : "unreachable"],
      ["Latest", s.workday.latest, true],
      ["Last sync", ago(s.workday.lastSync)],
      ["Detail", s.workday.health.detail],
    ],
  }));
}

/** Every employee the pipeline knows about, including ones not yet in Postgres. */
function allTracked() {
  const fromPg = snapshot.employees.map((e) => ({
    employeeId: e.employeeId,
    label: `${e.employeeId} · ${e.firstName} ${e.lastName}`,
    stages: e.stages,
    employee: e,
  }));
  const extra = (snapshot.pendingStages ?? []).map((p) => ({
    employeeId: p.employeeId,
    label: `${p.employeeId} · in flight`,
    stages: p.stages,
    employee: null,
  }));
  return [...extra, ...fromPg];
}

function renderFocusPicker() {
  const pick = $("#focusPick");
  const tracked = allTracked();
  const current = focusId ?? tracked[0]?.employeeId ?? "";
  pick.replaceChildren();
  if (tracked.length === 0) {
    pick.append(el("option", null, "no employees yet"));
    pick.disabled = true;
    return;
  }
  pick.disabled = false;
  for (const t of tracked) {
    const o = el("option", null, t.label);
    o.value = t.employeeId;
    if (t.employeeId === current) o.selected = true;
    pick.append(o);
  }
}

function renderPipeline() {
  const wrap = $("#pipeline");
  const tracked = allTracked();
  const target = tracked.find((t) => t.employeeId === focusId) ?? tracked[0];
  wrap.replaceChildren();

  if (!target) {
    wrap.append(el("p", "empty", "No employee yet. Press “+ Create Employee in BambooHR” to start the pipeline."));
    $("#pipelineHint").textContent = "";
    return;
  }

  const byStage = Object.fromEntries(target.stages.map((s) => [s.stage, s]));
  STAGES.forEach((stage, i) => {
    const st = byStage[stage.key] ?? { status: "pending", detail: null, attempts: 0 };
    const node = el("div", `node ${st.status}`);
    node.append(el("span", "n-icon", stage.icon));

    const mid = el("div");
    mid.append(el("div", "n-title", stage.title));
    const detail = st.detail || stage.note;
    mid.append(el("div", "n-detail", st.attempts > 1 ? `${detail} · attempt ${st.attempts}` : detail));
    node.append(mid);

    // The Workday node names the member it claimed — the question everyone asks first.
    if (stage.key === "workday") {
      const claim = (snapshot.slots?.slots ?? []).find((s) => s.employeeId === target.employeeId);
      if (claim) mid.append(el("span", "n-slot", `Slot: ${claim.slot}`));
    }
    node.append(el("span", "n-status", st.status));
    wrap.append(node);

    if (i < STAGES.length - 1) {
      const next = byStage[STAGES[i + 1].key]?.status ?? "pending";
      const cls = next === "synced" ? "done" : (st.status === "synced" && next === "processing") ? "active" : "";
      const conn = el("div", `connector ${cls}`);
      conn.append(el("span", "c-label", CONNECTOR_LABELS[i]));
      wrap.append(conn);
    }
  });

  const e = target.employee;
  const done = target.stages.every((s) => s.status === "synced");
  const failed = target.stages.find((s) => s.status === "failed");
  $("#pipelineHint").textContent = failed
    ? `Stopped at ${failed.stage}: ${failed.detail ?? "failed"} — use Retry in the table below.`
    : done
      ? `${target.employeeId} is synchronised across all four systems.`
      : snapshot.config.systems.striim.mode === "live"
        ? "Waiting on the live Striim reader, which polls BambooHR on a 5-minute floor enforced by the connector."
        : `Waiting on the Striim poller (every ${snapshot.config.striimPollMs}ms in mock mode).`;
  if (e) { /* employee detail is shown in the table */ }
}

function renderLog() {
  const list = $("#log");
  const follow = $("#followTail").checked;
  const events = snapshot.events;

  // Rebuild only when the set changed, and mark genuinely new lines so the animation fires once
  // rather than on every re-render.
  list.replaceChildren();
  for (const ev of events) {
    const li = el("li", ev.level);
    if (!renderedEventIds.has(ev.id)) li.classList.add("fresh");
    li.append(el("time", null, hhmmss(ev.at)));
    li.append(el("span", "msg", ev.message));
    list.append(li);
  }
  renderedEventIds = new Set(events.map((e) => e.id));
  if (follow) list.scrollTop = list.scrollHeight;
}

/** The slot pool, straight from the database. Nothing here is remembered client-side. */
function renderSlots() {
  const body = $("#slotRows");
  const data = snapshot.slots;
  body.replaceChildren();
  if (!data || data.slots.length === 0) {
    const tr = el("tr"); const td = el("td", "empty", "No slots configured (ADAPTIVE_DEMO_SLOTS).");
    td.colSpan = 5; tr.append(td); body.append(tr);
    $("#slotSummary").textContent = "";
    return;
  }
  const s = data.summary;
  $("#slotSummary").textContent =
    `${s.AVAILABLE} available · ${s.SYNCED} synced · ${s.CLAIMED + s.SYNCING} in flight · ${s.FAILED} failed`
    + ` of ${data.slots.length}`;

  for (const row of [...data.slots, ...(data.orphaned ?? [])]) {
    const tr = el("tr");
    tr.append(el("td", "slot", row.slot));
    tr.append(el("td", null, row.employeeName ?? "—"));
    tr.append(el("td", "id", row.employeeId ?? "—"));
    const st = el("td");
    const chip = el("span", `chip ${String(row.status).toLowerCase()}`, row.status);
    st.append(chip);
    tr.append(st);
    const d = el("td", "muted", row.detail ? String(row.detail).slice(0, 90) : "");
    tr.append(d);
    body.append(tr);
  }
}

function renderTable() {
  const body = $("#empRows");
  body.replaceChildren();
  const tracked = allTracked();
  $("#empCount").textContent = `${snapshot.systems.postgres.count} row${snapshot.systems.postgres.count === 1 ? "" : "s"} in syncdemo.employees`;

  if (tracked.length === 0) {
    const tr = el("tr");
    const td = el("td", "empty", "Nothing yet.");
    td.colSpan = 10;
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const t of tracked) {
    const e = t.employee;
    const tr = el("tr", t.employeeId === (focusId ?? tracked[0].employeeId) ? "focused" : "");
    tr.append(el("td", "id", t.employeeId));
    tr.append(el("td", null, e ? `${e.firstName} ${e.lastName}` : "—"));
    tr.append(el("td", null, e?.email ?? "—"));
    tr.append(el("td", null, e?.department ?? "—"));

    const byStage = Object.fromEntries(t.stages.map((s) => [s.stage, s]));
    for (const stage of STAGES) {
      const st = byStage[stage.key] ?? { status: "pending" };
      const td = el("td");
      const chip = el("span", `chip ${st.status}`, st.status);
      if (st.detail) chip.title = st.detail;
      td.append(chip);
      tr.append(td);
    }

    // Which Adaptive member this employee holds, if any.
    const claim = (snapshot.slots?.slots ?? []).find((s) => s.employeeId === t.employeeId)
      ?? (snapshot.slots?.orphaned ?? []).find((s) => s.employeeId === t.employeeId);
    tr.append(el("td", "slot", claim ? claim.slot : "—"));

    const actions = el("td");
    if (t.stages.some((s) => s.status === "failed")) {
      const b = el("button", "btn btn-tiny", "Retry");
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = "retrying…";
        try { await fetch(`/api/employees/${encodeURIComponent(t.employeeId)}/retry`, { method: "POST" }); }
        finally { void refresh(); }
      };
      actions.append(b);
    }
    tr.append(actions);

    tr.onclick = (ev) => {
      if (ev.target.tagName === "BUTTON") return;
      focusId = t.employeeId;
      userPickedFocus = true;
      render();
    };
    body.append(tr);
  }
}

function syncFaultToggles() {
  for (const box of document.querySelectorAll("[data-fault]")) {
    box.checked = Boolean(snapshot.faults?.[box.dataset.fault]);
  }
}

// ── actions ─────────────────────────────────────────────────────────────────────────────

const dialog = $("#createDialog");
const form = $("#createForm");

$("#btnCreate").onclick = () => {
  $("#formError").hidden = true;
  dialog.showModal();
  form.querySelector("[name=employeeId]").focus();
};
$("#btnCancel").onclick = () => dialog.close();

$("#btnSeed").onclick = () => {
  // The exact record from the acceptance test, so the demo can be run without typing.
  const n = 1001 + (snapshot?.systems.bamboohr.count ?? 0);
  const values = {
    employeeId: `EMP-${n}`,
    firstName: "Sarah", lastName: "Smith",
    email: `sarah${n === 1001 ? "" : `.${n}`}@example.com`,
    jobTitle: "Forward Deployed Engineer",
    department: "Engineering", location: "San Francisco",
    phone: "+1 415 555 0142", hireDate: new Date().toISOString().slice(0, 10),
    payRate: "100000",
  };
  for (const [k, v] of Object.entries(values)) {
    const input = form.querySelector(`[name=${k}]`);
    if (input) input.value = v;
  }
  $("#formError").hidden = true;
  dialog.showModal();
};

form.onsubmit = async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  const err = $("#formError");
  const submit = $("#btnSubmit");
  err.hidden = true;
  submit.disabled = true;
  submit.textContent = "Creating…";
  try {
    const r = await fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error ?? `Failed (${r.status})`; err.hidden = false; return; }
    focusId = j.employeeId;
    userPickedFocus = false;
    form.reset();
    dialog.close();
    void refresh();
  } catch (e) {
    err.textContent = String(e);
    err.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "Create";
  }
};

$("#focusPick").onchange = (ev) => {
  focusId = ev.target.value;
  userPickedFocus = true;
  render();
};

$("#btnForce").onclick = async (ev) => {
  const b = ev.currentTarget;
  const was = b.textContent;
  b.disabled = true;
  b.textContent = snapshot?.config.systems.striim.mode === "live" ? "restarting Striim…" : "reading…";
  try {
    const r = await fetch("/api/pipeline/force-read", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) alert(`Force read failed: ${j.detail ?? r.status}`);
  } finally {
    b.disabled = false;
    b.textContent = was;
    void refresh();
  }
};

$("#btnReset").onclick = async () => {
  if (!confirm("Clear every system — BambooHR mock, landing table, PostgreSQL, Workday mock and the log?")) return;
  await fetch("/api/reset", { method: "POST" });
  void refresh();
};

for (const box of document.querySelectorAll("[data-fault]")) {
  box.onchange = async () => {
    await fetch("/api/faults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [box.dataset.fault]: box.checked }),
    });
    void refresh();
  };
}

// "Last update / last sync" are relative times, so they need to tick even when nothing happens.
// This re-renders the cards only; it never changes a status.
setInterval(() => { if (snapshot) renderCards(); }, 5000);


// ── landing gate ─────────────────────────────────────────────────────────────────────────

/**
 * The first screen, in the language of the HR Workflow configurator: the systems as a sequence,
 * how many are connected, and Launch demo.
 *
 * The dots are each system's REAL health check, taken from the same snapshot the dashboard
 * renders. The configurator's vendor pickers are cosmetic; these are not, because a landing page
 * that asserted "Connected" without asking would be the one dishonest pixel in an app whose whole
 * claim is that its status is real.
 *
 * The choice is remembered for the browser SESSION only. Refreshing mid-demo must not throw you
 * back to the gate, and a fresh window must start at it.
 */
const LAUNCH_KEY = "moolai.launched";

function hasLaunched() {
  try { return sessionStorage.getItem(LAUNCH_KEY) === "1"; } catch { return false; }
}

function renderLanding() {
  if (!snapshot) return;
  const list = document.querySelector("#lpJourney");
  if (!list) return;
  const s = snapshot.systems;
  const cfg = snapshot.config.systems;

  const rows = LANDING_STAGES.map((st) => {
    const sys = s[st.key] ?? {};
    const c = cfg[st.key] ?? {};
    return {
      role: st.role,
      name: sys.name ?? st.key,
      mode: c.mode ?? sys.mode ?? "mock",
      ok: sys.health?.ok !== false,
      detail: sys.health?.detail ?? c.target ?? "",
    };
  });

  list.replaceChildren();
  rows.forEach((r, i) => {
    const li = el("li", `lp-stage ${r.ok ? "ok" : "bad"}`);
    const spine = el("div", "lp-spine");
    spine.append(el("span", "lp-n", String(i + 1).padStart(2, "0")), el("span", "lp-rail"));
    const body = el("div", "lp-body");
    body.append(el("span", "lp-role", r.role));
    body.append(el("h2", "lp-name", r.name));
    body.append(el("p", "lp-detail", r.detail));
    const badges = el("div", "lp-badges");
    const conn = el("span", `lp-conn ${r.ok ? "" : "bad"}`);
    conn.append(el("span", "dot"), document.createTextNode(r.ok ? "Connected" : "Unreachable"));
    badges.append(conn, el("span", `badge ${r.mode}`, r.mode));
    body.append(badges);
    li.append(spine, body);
    list.append(li);
  });

  const ok = rows.filter((r) => r.ok).length;
  const count = document.querySelector("#lpCount");
  count.className = `lp-count ${ok === rows.length ? "" : "partial"}`;
  count.replaceChildren(
    el("span", "dot"),
    document.createTextNode(`${ok} of ${rows.length} systems connected`));
}

function launch() {
  try { sessionStorage.setItem(LAUNCH_KEY, "1"); } catch { /* private window: this session only */ }
  document.body.classList.remove("pre-launch");
}

document.querySelector("#btnLaunch").onclick = launch;
// ?launched=1 skips the gate. The MoolAI home page on :5173 links here with it, because
// arriving from there is already the launch and a second identical gate is just a click to
// dismiss. A direct visit still gets the gate.
if (hasLaunched() || new URLSearchParams(location.search).get("launched") === "1") {
  launch();
}

void refresh();
connect();
