/**
 * Bring the whole demo up with one command.
 * @lifespan THROWAWAY — demo runner.
 *
 *   npm run up              API + simulator, UI, BambooHR watcher
 *   npm run up -- --all     the above plus the sync demo (:3000) and reverse demo (:3001)
 *   npm run up -- --no-hris just the API + UI (quieter migration panel — see below)
 *
 * WHY THIS EXISTS
 *
 * The demo is three processes and they are not interchangeable in start order. Starting the UI
 * before the API is up is the single most common way to break it: Vite proxies /employees and
 * /migration/status to 127.0.0.1:8090, and if nothing is listening yet the browser gets a proxy
 * error and the page renders "Couldn't reach the demo API" with no indication that the fix is
 * simply to wait. So this waits for 8090 to accept a connection before Vite is started at all.
 *
 * ORDER
 *   1  api   npm run interactive     API on 8090, Paylocity simulator on 8085
 *   2  ui    npm run ui:dev          Vite, proxying to the API (started only once 8090 answers)
 *   3  hris  npm run watch:bamboohr  map + enrich every 30s, so BambooHR additions appear
 *   4  sync  npm run syncdemo        --all only. the sync demo on :3000
 *   5  rev   npm run reversedemo     --all only. the reverse pipeline on :3001
 *
 * A NOTE ON STEP 3, because it is a real trade-off and not a free win.
 * The watcher re-touches every BambooHR-sourced row on each cycle, which bumps updated_at and
 * therefore produces continuous CDC traffic. While it runs, the migration panel's checksums
 * will flicker between matching and not as replication catches up — nothing is wrong, but it
 * looks unsettled. Pass --no-hris for the migration beats if you want a still panel, or press
 * the key below to stop just the watcher and leave everything else running.
 *
 * KEYS
 *   h   stop / start the BambooHR watcher without touching the API or UI
 *   q   quit everything (Ctrl-C does the same)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { platform } from "node:process";

const NO_HRIS = process.argv.includes("--no-hris");
const ALL = process.argv.includes("--all");
const API_PORT = 8090;

interface Proc { name: string; script: string; child?: ChildProcess }

const pad = (s: string) => s.padEnd(4);

/** Prefix every line so three processes in one terminal stay readable. */
function pipe(name: string, child: ChildProcess): void {
  const emit = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      const t = line.trimEnd();
      if (!t) continue;
      // Vite prints the URL with ANSI colour; keep it, it is the line people look for.
      console.log(`[${pad(name)}] ${t}`);
    }
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
}

function start(name: string, script: string): ChildProcess {
  // Own process group on POSIX so killTree can take the whole tree below the shell.
  const child = spawn("npm", ["run", script],
    { stdio: ["ignore", "pipe", "pipe"], shell: true, detached: platform !== "win32" });
  pipe(name, child);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log(`[${pad(name)}] exited with code ${code}`);
  });
  return child;
}

/** True once something accepts a TCP connection on the port. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

async function waitForPort(port: number, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Kill the whole tree. `npm run x` on Windows is cmd.exe wrapping node, so killing the pid we
 * hold leaves the actual server orphaned holding port 8090 — which is exactly the "port in use"
 * mess the runbook has a troubleshooting row for. taskkill /T takes the children with it.
 */
function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  if (platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  } else {
    // Negative pid = the whole group: the shell, npm, and the server itself.
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

const procs: Proc[] = [];
let hris: ChildProcess | undefined;

function shutdown(): void {
  console.log("\nstopping everything...");
  for (const p of procs) killTree(p.child);
  killTree(hris);
  // Give taskkill a moment to land before the process group disappears.
  setTimeout(() => process.exit(0), 1200);
}

async function main(): Promise<void> {
  console.log("starting the Instant Teams demo\n");

  // Reuse an API that is already up rather than fighting it for the port. Restarting it would
  // also wipe the approvals inbox, which is not what someone re-running this command expects.
  if (await portOpen(API_PORT)) {
    console.log(`[${pad("api")}] already listening on ${API_PORT} — reusing it`);
  } else {
    const api = start("api", "interactive");
    procs.push({ name: "api", script: "interactive", child: api });
    console.log(`[${pad("api")}] waiting for ${API_PORT} (Temporal test server takes ~30-60s on a cold start)`);
    if (!await waitForPort(API_PORT, 180)) {
      console.log(`[${pad("api")}] never came up — leaving it running so you can read the error above`);
      return;
    }
    console.log(`[${pad("api")}] up`);
  }

  const ui = start("ui", "ui:dev");
  procs.push({ name: "ui", script: "ui:dev", child: ui });

  if (ALL) {
    const extras = [["sync", "syncdemo", 3000], ["rev", "reversedemo", 3001]] as const;
    for (const [name, script, port] of extras) {
      if (await portOpen(port)) {
        console.log(`[${pad(name)}] already listening on ${port} — reusing it`);
        continue;
      }
      procs.push({ name, script, child: start(name, script) });
    }
  }

  if (!NO_HRIS) {
    hris = start("hris", "watch:bamboohr");
  } else {
    console.log(`[${pad("hris")}] skipped (--no-hris)`);
  }

  console.log("\n  everything is starting. Open the URL Vite prints below (usually http://localhost:5173)");
  if (ALL) console.log("  sync demo http://localhost:3000 — reverse demo http://localhost:3001");
  console.log("  press h to toggle the BambooHR watcher, q or Ctrl-C to stop everything\n");

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (b: Buffer) => {
      const k = b.toString().toLowerCase();
      if (k === "q" || k === "") { shutdown(); return; }
      if (k !== "h") return;
      if (hris) {
        console.log(`[${pad("hris")}] stopping the watcher — the migration panel will settle`);
        killTree(hris); hris = undefined;
      } else {
        console.log(`[${pad("hris")}] starting the watcher`);
        hris = start("hris", "watch:bamboohr");
      }
    });
  }
}

main().catch((e: Error) => { console.error(e.message); shutdown(); });
