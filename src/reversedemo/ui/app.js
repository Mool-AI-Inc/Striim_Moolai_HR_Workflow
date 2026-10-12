/* Reverse pipeline dashboard.
 *
 * Same rule as the forward one: this renders server state and never invents it. Every status comes
 * from GET /api/snapshot, which reads Postgres; SSE only says "something changed, look again".
 */

const STAGES = [
  { key: "workday",  title: "Workday / Adaptive", icon: "1", note: "Source — read only" },
  { key: "striim",   title: "Striim",             icon: "2", note: "Transform + synthesise email" },
  { key: "postgres", title: "PostgreSQL",         icon: "3", note: "Intermediate database" },
  { key: "bamboohr", title: "BambooHR",           icon: "4", note: "Target — creates a real person" },
];
const CONNECTORS = ["export", "stream", "create"];

let snapshot = null;
let focusId = null;
let userPicked = false;
let renderedEventIds = new Set();

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const hhmmss = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : "--:--:--");

let pending = false;
let queued = false;
async function refresh() {
  if (pending) { queued = true; return; }
  pending = true;
  try {
    const r = await fetch("/api/snapshot");
    if (!r.ok) throw new Error(`snapshot ${r.status}`);
    snapshot = await r.json();
    render();
  } catch (e) {
    console.error("snapshot failed", e);
  } finally {
    pending = false;
    if (queued) { queued = false; void refresh(); }
  }
}

function connect() {
  const es = new EventSource("/api/stream");
  const dot = $("#connDot");
  es.onopen = () => { dot.className = "conn on"; dot.querySelector(".conn-label").textContent = "live"; };
  es.onerror = () => { dot.className = "conn off"; dot.querySelector(".conn-label").textContent = "reconnecting"; };
  es.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === "reset") { focusId = null; userPicked = false; renderedEventIds = new Set(); }
    if (msg.type === "stage" && !userPicked) focusId = msg.employeeId;
    void refresh();
  };
}

const LANDING_STAGES = [
  { key: "workday",  role: "Source of truth" },
  { key: "striim",   role: "Change data capture" },
  { key: "postgres", role: "Intermediate database" },
  { key: "bamboohr", role: "Downstream target" },
];

function render() {
  if (!snapshot) return;
  renderLanding();
  renderBadges();
  renderWarning();
  renderCards();
  renderCandidates();
  renderFocus();
  renderPipeline();
  renderLog();
  renderRows();
}

function renderBadges() {
  const wrap = $("#modeBadges");
  wrap.replaceChildren();
  const s = snapshot.config.systems;
  for (const [k, label] of [["workday", "Workday"], ["striim", "Striim"], ["postgres", "Postgres"], ["bamboohr", "BambooHR"]]) {
    const v = s[k];
    const b = el("span", `badge ${v.mode}`, `${label} ${v.mode}`);
    b.title = v.reason ? `${v.target} — ${v.reason}` : String(v.target ?? "");
    wrap.append(b);
  }
}

/** The one thing a presenter must not forget. */
function renderWarning() {
  const bar = $("#warnbar");
  const live = snapshot.config.systems.bamboohr.mode === "live";
  bar.className = live ? "warnbar on" : "warnbar";
  bar.textContent = live
    ? `BambooHR is LIVE — importing creates a real, permanent employee in ${snapshot.config.systems.bamboohr.target}. `
      + "The API has no delete, only termination, and each create consumes a seat. "
      + `Emails are synthesised at @${snapshot.config.emailDomain}.`
    : "BambooHR is mocked — nothing is written to a real HRIS. Set REVDEMO_BAMBOOHR_MODE=live to import for real.";
}

function card({ name, mode, metric, metricLabel, ok, rows }) {
  const c = el("div", `card ${ok === false ? "bad" : ok === true ? "ok" : ""}`);
  const head = el("div", "card-head");
  head.append(el("span", "card-name", name), el("span", `badge ${mode}`, mode));
  const m = el("div", "card-metric");
  m.append(document.createTextNode(metric === -1 ? "—" : String(metric)));
  m.append(el("small", null, ` ${metricLabel}`));
  const dl = el("dl", "kv");
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === "") continue;
    const row = el("div");
    row.append(el("dt", null, k), el("dd", null, String(v)));
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
    name: "Workday / Adaptive", mode: s.workday.mode, metric: s.workday.count,
    metricLabel: "members read", ok: s.workday.health.ok,
    rows: [["Connection", s.workday.health.ok ? "connected" : "unreachable"], ["Detail", s.workday.health.detail]],
  }));
  wrap.append(card({
    name: "Striim", mode: s.striim.mode, metric: s.striim.count, metricLabel: "records transformed",
    ok: s.striim.health.ok, rows: [["Leg", s.striim.health.detail]],
  }));
  wrap.append(card({
    name: "PostgreSQL", mode: "live", metric: s.postgres.count, metricLabel: "employees",
    ok: s.postgres.health.ok,
    rows: [["Connection", s.postgres.health.ok ? "connected" : "unreachable"], ["Database", s.postgres.health.detail]],
  }));
  wrap.append(card({
    name: "BambooHR", mode: s.bamboohr.mode, metric: s.bamboohr.count,
    metricLabel: s.bamboohr.mode === "live" ? "in the account" : "created by this pipeline",
    ok: s.bamboohr.health.ok,
    rows: [
      ["Created", `${s.bamboohr.created} by this pipeline`],
      ["Failed", s.bamboohr.failed || undefined],
      ["Detail", s.bamboohr.health.detail],
    ],
  }));
}

function renderCandidates() {
  const pick = $("#pick");
  const prev = pick.value;
  const list = (snapshot.candidates ?? []).filter((c) => !c.mapped);
  pick.replaceChildren();
  if (list.length === 0) {
    pick.append(el("option", null, "no un-imported Workday members"));
    pick.disabled = true;
    $("#btnImport").disabled = true;
    return;
  }
  pick.disabled = false;
  $("#btnImport").disabled = false;
  for (const c of list) {
    const o = el("option", null,
      `${c.memberId} · ${c.workerName}${c.location ? ` · ${c.location}` : ""}${c.payRate !== undefined ? ` · ${c.payRate}` : ""}`);
    o.value = c.memberId;
    pick.append(o);
  }
  if (prev && list.some((c) => c.memberId === prev)) pick.value = prev;
}

function tracked() { return snapshot.employees ?? []; }

function renderFocus() {
  const sel = $("#focusPick");
  const list = tracked();
  const current = focusId ?? list[0]?.memberId ?? "";
  sel.replaceChildren();
  if (list.length === 0) { sel.append(el("option", null, "nothing imported yet")); sel.disabled = true; return; }
  sel.disabled = false;
  for (const e of list) {
    const o = el("option", null, `${e.memberId} · ${e.firstName} ${e.lastName}`);
    o.value = e.memberId;
    if (e.memberId === current) o.selected = true;
    sel.append(o);
  }
}

function renderPipeline() {
  const wrap = $("#pipeline");
  const list = tracked();
  const target = list.find((e) => e.memberId === focusId) ?? list[0];
  wrap.replaceChildren();
  if (!target) {
    wrap.append(el("p", "empty", "Pick a Workday member above and press Import to start the pipeline."));
    $("#pipelineHint").textContent = "";
    return;
  }
  const by = Object.fromEntries((target.stages ?? []).map((s) => [s.stage, s]));
  STAGES.forEach((stage, i) => {
    const st = by[stage.key] ?? { status: "pending", detail: null, attempts: 0 };
    const node = el("div", `node ${st.status}`);
    node.append(el("span", "n-icon", stage.icon));
    const mid = el("div");
    mid.append(el("div", "n-title", stage.title));
    mid.append(el("div", "n-detail", st.detail || stage.note));
    if (stage.key === "bamboohr" && target.bambooEmployeeId) {
      mid.append(el("span", "n-slot", `BambooHR id: ${target.bambooEmployeeId}`));
    }
    node.append(mid);
    node.append(el("span", "n-status", st.status));
    wrap.append(node);
    if (i < STAGES.length - 1) {
      const next = by[STAGES[i + 1].key]?.status ?? "pending";
      const cls = next === "synced" ? "done" : (st.status === "synced" && next === "processing") ? "active" : "";
      const conn = el("div", `connector ${cls}`);
      conn.append(el("span", "c-label", CONNECTORS[i]));
      wrap.append(conn);
    }
  });
  const failed = (target.stages ?? []).find((s) => s.status === "failed");
  const done = (target.stages ?? []).every((s) => s.status === "synced");
  $("#pipelineHint").textContent = failed
    ? `Stopped at ${failed.stage}: ${failed.detail ?? "failed"} — use Retry in the table.`
    : done
      ? `${target.memberId} is in BambooHR as ${target.bambooEmployeeId ?? "—"}.`
      : "In flight.";
}

function renderLog() {
  const list = $("#log");
  const follow = $("#followTail").checked;
  list.replaceChildren();
  for (const ev of snapshot.events ?? []) {
    const li = el("li", ev.level);
    if (!renderedEventIds.has(ev.id)) li.classList.add("fresh");
    li.append(el("time", null, hhmmss(ev.at)));
    li.append(el("span", "msg", ev.message));
    list.append(li);
  }
  renderedEventIds = new Set((snapshot.events ?? []).map((e) => e.id));
  if (follow) list.scrollTop = list.scrollHeight;
}

function renderRows() {
  const body = $("#rows");
  body.replaceChildren();
  const m = snapshot.mappingSummary ?? {};
  $("#mapSummary").textContent =
    `${m.CREATED ?? 0} created · ${m.FAILED ?? 0} failed · ${(snapshot.candidates ?? []).filter((c) => !c.mapped).length} not yet imported`;

  const list = tracked();
  if (list.length === 0) {
    const tr = el("tr"); const td = el("td", "empty", "Nothing imported yet.");
    td.colSpan = 10; tr.append(td); body.append(tr); return;
  }
  for (const e of list) {
    const tr = el("tr", e.memberId === (focusId ?? list[0].memberId) ? "focused" : "");
    tr.append(el("td", "id", e.memberId));
    tr.append(el("td", null, `${e.firstName} ${e.lastName}`));
    tr.append(el("td", "slot", e.email));
    tr.append(el("td", null, e.payRate === undefined ? "—" : String(e.payRate)));
    const by = Object.fromEntries((e.stages ?? []).map((s) => [s.stage, s]));
    for (const stage of STAGES) {
      const st = by[stage.key] ?? { status: "pending" };
      const td = el("td");
      const chip = el("span", `chip ${st.status}`, st.status);
      if (st.detail) chip.title = st.detail;
      td.append(chip);
      tr.append(td);
    }
    tr.append(el("td", "id", e.bambooEmployeeId ?? "—"));
    const actions = el("td");
    if ((e.stages ?? []).some((s) => s.status === "failed")) {
      const b = el("button", "btn btn-tiny", "Retry");
      b.onclick = async () => {
        b.disabled = true; b.textContent = "retrying…";
        try { await fetch(`/api/import/${encodeURIComponent(e.memberId)}/retry`, { method: "POST" }); }
        finally { void refresh(); }
      };
      actions.append(b);
    }
    tr.append(actions);
    tr.onclick = (ev) => {
      if (ev.target.tagName === "BUTTON") return;
      focusId = e.memberId; userPicked = true; render();
    };
    body.append(tr);
  }
}

// ── actions ───────────────────────────────────────────────────────────────────────────────

$("#btnRefresh").onclick = async (ev) => {
  const b = ev.currentTarget;
  b.disabled = true; const was = b.textContent; b.textContent = "reading Workday…";
  try { await fetch("/api/workday/refresh", { method: "POST" }); }
  finally { b.disabled = false; b.textContent = was; void refresh(); }
};

$("#btnImport").onclick = async (ev) => {
  const id = $("#pick").value;
  if (!id) return;
  const live = snapshot?.config.systems.bamboohr.mode === "live";
  // Confirmation only when it is real, and it names the consequence rather than asking "are you
  // sure" — the create cannot be undone through any API we have.
  if (live && !confirm(
    `Create ${id} as a REAL, PERMANENT employee in BambooHR (${snapshot.config.systems.bamboohr.target})?\n\n`
    + "BambooHR has no delete API — the person can only be marked terminated afterwards, and the "
    + "create consumes a seat on the account.")) return;

  const b = ev.currentTarget;
  b.disabled = true; const was = b.textContent; b.textContent = "importing…";
  try {
    const r = await fetch(`/api/import/${encodeURIComponent(id)}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) alert(`Import failed: ${j.error ?? r.status}`);
    else { focusId = id; userPicked = false; }
  } finally {
    b.disabled = false; b.textContent = was; void refresh();
  }
};

$("#focusPick").onchange = (ev) => { focusId = ev.target.value; userPicked = true; render(); };

$("#btnReset").onclick = async () => {
  if (!confirm(
    "Clear local state (landing table, intermediate table, mapping, log)?\n\n"
    + "This does NOT delete anyone from BambooHR — that API has no delete. Previously imported "
    + "people become importable again, and a re-import will match them by email rather than "
    + "creating a duplicate.")) return;
  await fetch("/api/reset", { method: "POST" });
  void refresh();
};


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
