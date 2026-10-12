import { defineConfig } from "vitest/config";

// Time-skipping workflow tests run SERIALLY — the test server's skipping clock is process-global,
// so parallel files would corrupt each other's time. `pool: "forks"` isolates each file's process.
// Invoked via `vitest run --config vitest.temporal.config.ts` (npm run test:temporal).
export default defineConfig({
  test: {
    include: ["test/workflows/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
