import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Three named projects (Vitest 4: `test.projects`; the removed `workspace` file is not used).
//  unit        — everything under test/ except the temporal (workflow), integration, UI and
//                syncdemo tiers
//  integration — the ledger tier that needs compose Postgres (npm run test:integration)
//  ui          — the approval-app tier (jsdom + React), Plan 1
//  syncdemo    — the BambooHR->Striim->Postgres->Workday pipeline (npm run syncdemo:test)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/workflows/**", "test/integration/**", "test/approval-app/**", "test/syncdemo/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "syncdemo",
          include: ["test/syncdemo/**/*.test.ts"],
          // SYNCDEMO_SCHEMA must be set BEFORE any module loads, not in beforeAll. db.ts reads it
          // once at module-evaluation time, and the test file's static imports pull db.ts in
          // before any hook runs — so setting it in beforeAll left the suite pointed at the
          // default `syncdemo` schema, which is the one a running dev server owns. Its 1.5s
          // poller then processed the tests' records and, because the fault switches are
          // per-process, completed pipelines the tests had deliberately broken. The failures
          // moved around between runs, which is what a race looks like.
          // Both schemas, for the same reason: db.ts reads its schema name once at
          // module-evaluation time and the test files' static imports pull it in before any
          // hook runs, so setting it in beforeAll is too late and silently leaves the suite
          // pointed at the schema a running dev server owns.
          env: {
            SYNCDEMO_SCHEMA: "syncdemo_test",
            REVDEMO_SCHEMA: "revdemo_test",
            // Striim OFF for the suite. .env now has REVDEMO_STRIIM_MODE=live, and the real
            // ReverseDemoCDC application replicates `revdemo.employees` — the production
            // schema. The tests write to revdemo_test, so nothing ever arrives and every
            // import waited out the full 60s timeout. Mocking the Striim leg here is not
            // skipping coverage: the transform, the mapping and the idempotency gate are the
            // same code either way, and what live mode adds is a wait on another process.
            REVDEMO_STRIIM_MODE: "mock",
          },
          // One file, and the stages are ordered — no reason to fan out, and a second worker
          // sharing the schema would reintroduce exactly the race described above.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["test/approval-app/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
