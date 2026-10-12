/**
 * Keep the platform's employees table in step with BambooHR, hands-off.
 * @lifespan THROWAWAY — demo runner.
 *
 *   npm run watch:bamboohr
 *
 * Striim lands the BambooHR directory into bamboohr_employees on its own schedule. This runs
 * the other half on a timer: map that landing table into the employees table the platform
 * reads, then enrich the fields the reader cannot fetch. Both live in
 * scripts/sync-bamboohr.ts, which is what this spawns.
 *
 * Deliberately a separate process from the app. The demo API should not grow a background
 * job: if this dies, the platform keeps serving whatever it already has.
 */
import { spawn } from "node:child_process";

const EVERY_MS = Number(process.env.WATCH_INTERVAL_MS ?? 30_000);

interface Pass { ok: boolean; line: string }

function runOnce(): Promise<Pass> {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsx", "--env-file-if-exists=.env", "scripts/sync-bamboohr.ts"],
                    { stdio: ["ignore", "pipe", "pipe"], shell: true });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    // The exit code is the only reliable signal. The previous version resolved on close
    // without reading it, so a sync that failed every single time still printed a tidy line
    // and the watcher looked healthy — the worst possible failure mode for something you are
    // standing in front of an audience trusting.
    p.on("close", (code) => {
      const pick = (needle: string) => out.split("\n").find((l) => l.includes(needle))?.trim();
      const line = code === 0
        ? [pick("map:"), pick("BambooHR employees now")].filter(Boolean).join("  |  ")
          || out.trim().slice(0, 160)
        : (pick("sync failed") ?? pick("Error") ?? out.trim().slice(-200));
      resolve({ ok: code === 0, line: line || `exit ${code}` });
    });
  });
}

async function main(): Promise<void> {
  console.log(`watching BambooHR — map + enrich every ${EVERY_MS / 1000}s. Ctrl-C to stop.\n`);
  let consecutiveFailures = 0;
  for (;;) {
    const { ok, line } = await runOnce();
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`[${stamp}] ${ok ? "ok  " : "FAIL"} ${line}`);
    // Back off on repeated failure rather than hammering a dead BambooHR tenant or a halted
    // Striim app every 30s for the rest of the afternoon.
    consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= 3) {
      console.log(`[${stamp}] ${consecutiveFailures} failures in a row — backing off to ${EVERY_MS * 4 / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, consecutiveFailures >= 3 ? EVERY_MS * 4 : EVERY_MS));
  }
}
main().catch((e: Error) => { console.error(e.message); process.exit(1); });
