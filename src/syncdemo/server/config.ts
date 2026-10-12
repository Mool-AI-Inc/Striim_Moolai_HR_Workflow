/**
 * Configuration and mode resolution for the sync demo.
 * @lifespan PRODUCTION — the one place that reads process.env for this app.
 * @responsibility Resolve the Postgres URL, decide per-system live/mock, hold nothing secret.
 *
 * WHY MOCK IS THE DEFAULT EVEN WHEN CREDENTIALS EXIST
 *
 * The brief says real credentials in .env should let the app talk to the real systems. It does —
 * but only when SYNCDEMO_MODE=live is set explicitly, and that is a deliberate deviation.
 *
 * This repo's .env already holds working BambooHR and Workday Adaptive credentials. Defaulting
 * to "credentials present, therefore live" would mean that pressing Create Employee on a demo
 * dashboard creates a REAL person in a real HRIS, and writes a REAL pay figure into a Workday
 * Adaptive planning model that a Slack agent answers pay-equity questions from. Neither is
 * reversible from this UI. An explicit opt-in is one environment variable; an accidental write
 * into a planning model is a phone call.
 *
 * In live mode each system is independent: a system with credentials goes live, one without
 * stays mocked, and the UI says which is which per system rather than claiming one global mode.
 */

import { configuredSlots } from "./slots.js";

export type SystemMode = "mock" | "live";

export interface SystemConfig {
  mode: SystemMode;
  /** Shown in the UI when mocked, to say WHY it is mocked. */
  reason?: string;
}

export interface SyncDemoConfig {
  port: number;
  databaseUrl: string;
  /** Pre-allocated Adaptive members available to the allocator, in allocation order. */
  demoSlots: string[];
  /** How often the Striim mock polls the source for changes, in ms. */
  striimPollMs: number;
  /** How often the real-Striim adapter re-checks the landing table, in ms. */
  striimLivePollMs: number;
  bamboohr: SystemConfig & { domain?: string; apiKey?: string; baseUrl?: string };
  striim: SystemConfig & { url?: string; user?: string; password?: string; namespace: string; app: string };
  workday: SystemConfig & {
    apiUrl?: string; tokenUrl?: string; tokenExchangeUrl?: string;
    clientId?: string; clientSecret?: string; refreshToken?: string;
    version?: string; instanceCode?: string; sheetName: string; importKey: string;
    /** Display name, for the UI only. Adaptive rejects it as a Level value. */
    level?: string;
    /**
     * The INTERNAL level code, which is what Adaptive accepts.
     * "SUPERVISORY_Workforce_Planning_Department", not "Workforce Planning Department" —
     * the display name comes back as "Invalid Level Choice: ... on row 1 column A". The real
     * value is the third column of an exportData with useInternalCodes="true".
     */
    levelCode: string;
    /**
     * The metric column to write. "PY Pay" is the only writable column on the EUPTD import
     * template; Headcount, Salary, Taxes, Tenure in Months and Total Compensation are each
     * rejected with "Invalid header name(s)".
     */
    metricColumn: string;
    /** Pin the period (MM/YYYY) instead of using the current month. Empty = current. */
    writeMonth: string;
  };
}

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

/**
 * Postgres connection, in precedence order:
 *   1. SYNCDEMO_DATABASE_URL  — explicit, wins
 *   2. POSTGRES_*             — the discrete variables the brief specifies; what compose sets
 *   3. LEDGER_DATABASE_URL    — this repo's existing Neon database, so the demo runs with no
 *                              new configuration at all on a machine already set up for it
 */
function resolveDatabaseUrl(): string {
  const explicit = env("SYNCDEMO_DATABASE_URL");
  if (explicit) return explicit;

  const host = env("POSTGRES_HOST");
  if (host) {
    const port = env("POSTGRES_PORT") ?? "5432";
    const db = env("POSTGRES_DB") ?? "syncdemo";
    const user = env("POSTGRES_USER") ?? "postgres";
    const password = env("POSTGRES_PASSWORD") ?? "postgres";
    const ssl = env("POSTGRES_SSLMODE");
    const q = ssl ? `?sslmode=${encodeURIComponent(ssl)}` : "";
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}${q}`;
  }

  const ledger = env("LEDGER_DATABASE_URL");
  if (ledger) return ledger;

  throw new Error(
    "no database configured — set SYNCDEMO_DATABASE_URL, or POSTGRES_HOST/PORT/DB/USER/PASSWORD, "
    + "or LEDGER_DATABASE_URL",
  );
}

/** Per-system override: SYNCDEMO_<SYSTEM>_MODE beats the global SYNCDEMO_MODE. */
function wanted(system: string): SystemMode | undefined {
  const one = env(`SYNCDEMO_${system.toUpperCase()}_MODE`)?.toLowerCase();
  if (one === "live" || one === "mock") return one;
  const all = env("SYNCDEMO_MODE")?.toLowerCase();
  if (all === "live" || all === "mock") return all;
  return undefined;
}

function resolve(system: string, credentials: Record<string, string | undefined>): SystemConfig {
  const want = wanted(system) ?? "mock";
  if (want === "mock") {
    return { mode: "mock", reason: wanted(system) ? "forced by configuration" : "SYNCDEMO_MODE is not live" };
  }
  const missing = Object.entries(credentials).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return { mode: "mock", reason: `live requested but missing ${missing.join(", ")}` };
  }
  return { mode: "live" };
}

export function loadConfig(): SyncDemoConfig {
  const bambooDomain = env("BAMBOOHR_DOMAIN");
  const bambooKey = env("BAMBOOHR_API_KEY");

  // Workday Adaptive. WORKDAY_* names come from the brief; ADAPTIVE_* are what this repo
  // already uses and what the working agent in the sibling project uses, so both are accepted
  // and the repo's existing .env needs no edit.
  const wdClientId = env("WORKDAY_CLIENT_ID") ?? env("ADAPTIVE_CLIENT_ID");
  const wdClientSecret = env("WORKDAY_CLIENT_SECRET") ?? env("ADAPTIVE_CLIENT_SECRET");
  const wdRefresh = env("WORKDAY_REFRESH_TOKEN") ?? env("ADAPTIVE_REFRESH_TOKEN");
  const wdTokenUrl = env("WORKDAY_TOKEN_URL") ?? env("ADAPTIVE_TOKEN_URL");
  const wdExchange = env("WORKDAY_TOKEN_EXCHANGE_URL") ?? env("ADAPTIVE_TOKEN_EXCHANGE_URL");
  const wdApi = env("WORKDAY_BASE_URL") ?? env("ADAPTIVE_API_URL");

  const striimUrl = env("STRIIM_URL");
  const striimUser = env("STRIIM_USER");
  const striimPass = env("STRIIM_PASSWORD") ?? env("STRIIM_PASS");

  return {
    port: Number(env("SYNCDEMO_PORT") ?? env("PORT") ?? 3000),
    databaseUrl: resolveDatabaseUrl(),
    striimPollMs: Number(env("SYNCDEMO_STRIIM_POLL_MS") ?? 1500),
    // Delegated: slots.ts is the only parser of ADAPTIVE_DEMO_SLOTS.
    demoSlots: configuredSlots(),
    striimLivePollMs: Number(env("SYNCDEMO_STRIIM_LIVE_POLL_MS") ?? 10_000),

    bamboohr: {
      ...resolve("bamboohr", { BAMBOOHR_DOMAIN: bambooDomain, BAMBOOHR_API_KEY: bambooKey }),
      domain: bambooDomain,
      apiKey: bambooKey,
      baseUrl: env("BAMBOOHR_BASE_URL"),
    },

    striim: {
      ...resolve("striim", { STRIIM_URL: striimUrl, STRIIM_USER: striimUser, STRIIM_PASSWORD: striimPass }),
      url: striimUrl,
      user: striimUser,
      password: striimPass,
      namespace: env("STRIIM_MIGRATION_NS") ?? "sarah_moolai",
      app: env("SYNCDEMO_STRIIM_APP") ?? "BambooHRToPostgres",
    },

    workday: {
      ...resolve("workday", {
        WORKDAY_CLIENT_ID: wdClientId, WORKDAY_CLIENT_SECRET: wdClientSecret,
        WORKDAY_REFRESH_TOKEN: wdRefresh, WORKDAY_TOKEN_URL: wdTokenUrl,
        WORKDAY_TOKEN_EXCHANGE_URL: wdExchange, WORKDAY_BASE_URL: wdApi,
      }),
      apiUrl: wdApi, tokenUrl: wdTokenUrl, tokenExchangeUrl: wdExchange,
      clientId: wdClientId, clientSecret: wdClientSecret, refreshToken: wdRefresh,
      version: env("ADAPTIVE_VERSION"), instanceCode: env("ADAPTIVE_INSTANCE_CODE"),
      level: env("ADAPTIVE_LEVEL") ?? "",
      levelCode: env("ADAPTIVE_LEVEL_CODE") ?? "SUPERVISORY_Workforce_Planning_Department",
      metricColumn: env("ADAPTIVE_METRIC_COLUMN") ?? "PY Pay",
      writeMonth: env("ADAPTIVE_WRITE_MONTH") ?? "",
      sheetName: env("ADAPTIVE_SHEET_NAME") ?? "EUPTD - Employee Demographics",
      importKey: env("ADAPTIVE_IMPORT_KEY") ?? "EmpID_EUPTD",
    },
  };
}

/** Never send a secret to the browser — only whether one is present. */
export function publicConfig(c: SyncDemoConfig) {
  const host = (() => {
    try { return new URL(c.databaseUrl).host; } catch { return "unknown"; }
  })();
  const dbName = (() => {
    try { return new URL(c.databaseUrl).pathname.replace(/^\//, "") || "unknown"; } catch { return "unknown"; }
  })();
  return {
    systems: {
      bamboohr: { mode: c.bamboohr.mode, reason: c.bamboohr.reason, target: c.bamboohr.mode === "live" ? c.bamboohr.domain : "in-process mock" },
      striim: { mode: c.striim.mode, reason: c.striim.reason, target: c.striim.mode === "live" ? `${c.striim.namespace}.${c.striim.app}` : "in-process change poller" },
      postgres: { mode: "live" as const, target: `${host}/${dbName}` },
      workday: {
        mode: c.workday.mode, reason: c.workday.reason,
        target: c.workday.mode === "live" ? c.workday.sheetName : "in-process mock",
        metricColumn: c.workday.metricColumn,
        levelCode: c.workday.levelCode,
      },
    },
    demoSlots: c.demoSlots,
    striimPollMs: c.striimPollMs,
    striimLivePollMs: c.striimLivePollMs,
  };
}
