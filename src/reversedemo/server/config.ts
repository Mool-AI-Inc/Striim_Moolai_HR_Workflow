/**
 * Configuration for the reverse pipeline.
 * @lifespan PRODUCTION — the one place that reads process.env for this app.
 *
 * Shares the ADAPTIVE_* / BAMBOOHR_* / POSTGRES_* variables with the forward pipeline, because
 * they describe the same three systems and duplicating them would let the two drift. Its own
 * REVDEMO_* variables cover only what differs: the port, the schema, and the one new decision
 * this direction has to make — what email address to invent.
 */
export type SystemMode = "mock" | "live";

export interface ReverseConfig {
  port: number;
  databaseUrl: string;
  /** Domain for synthesised work emails. Adaptive carries none; BambooHR demands one. */
  emailDomain: string;
  /** Cap on how many people one request may import. Guards against a fat-fingered bulk action. */
  maxPerRequest: number;
  /**
   * How often to re-read Workday, in ms. 0 disables it.
   *
   * Polling the SOURCE is safe — exportData is read-only, so the worst case is a wasted
   * request. Note what is NOT polled: the import. A loop that imported automatically would
   * create permanent BambooHR records unattended, so detection is automatic and the write
   * stays a deliberate click.
   */
  workdayPollMs: number;
  striimMode: SystemMode;
  striimNote: string;
  /** The database Striim replicates into. Required when striimMode is live. */
  targetDatabaseUrl?: string;
  /** How long to wait for Striim to deliver before giving up, in ms. */
  striimWaitMs: number;
  /** The Striim application that does the replication, for the dashboard. */
  striimApp: string;
  workday: {
    mode: SystemMode; reason?: string;
    apiUrl?: string; tokenUrl?: string; tokenExchangeUrl?: string;
    clientId?: string; clientSecret?: string; refreshToken?: string;
    version?: string; instanceCode?: string;
    sheetName: string; importKey: string; levelCode: string;
    /** The account whose rows carry the people. PayRate gives one row per person plus their pay. */
    account: string;
    /** MM/YYYY to read. Blank = current month. */
    readMonth: string;
  };
  bamboohr: { mode: SystemMode; reason?: string; domain?: string; apiKey?: string };
}

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

function resolveDatabaseUrl(): string {
  const explicit = env("REVDEMO_DATABASE_URL") ?? env("SYNCDEMO_DATABASE_URL");
  if (explicit) return explicit;
  const host = env("POSTGRES_HOST");
  if (host) {
    const port = env("POSTGRES_PORT") ?? "5432";
    const db = env("POSTGRES_DB") ?? "syncdemo";
    const user = env("POSTGRES_USER") ?? "postgres";
    const password = env("POSTGRES_PASSWORD") ?? "postgres";
    const ssl = env("POSTGRES_SSLMODE");
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`
         + (ssl ? `?sslmode=${encodeURIComponent(ssl)}` : "");
  }
  const ledger = env("LEDGER_DATABASE_URL");
  if (ledger) return ledger;
  throw new Error("no database configured — set REVDEMO_DATABASE_URL or LEDGER_DATABASE_URL");
}

/** REVDEMO_<SYSTEM>_MODE beats REVDEMO_MODE. Mock unless told otherwise, as in the forward app. */
function wanted(system: string): SystemMode | undefined {
  const one = env(`REVDEMO_${system.toUpperCase()}_MODE`)?.toLowerCase();
  if (one === "live" || one === "mock") return one;
  const all = env("REVDEMO_MODE")?.toLowerCase();
  if (all === "live" || all === "mock") return all;
  return undefined;
}

function resolve(system: string, creds: Record<string, string | undefined>): { mode: SystemMode; reason?: string } {
  const want = wanted(system) ?? "mock";
  if (want === "mock") {
    return { mode: "mock", reason: wanted(system) ? "forced by configuration" : "REVDEMO_MODE is not live" };
  }
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { mode: "mock", reason: `live requested but missing ${missing.join(", ")}` };
  return { mode: "live" };
}

export function loadReverseConfig(): ReverseConfig {
  const wdClientId = env("WORKDAY_CLIENT_ID") ?? env("ADAPTIVE_CLIENT_ID");
  const wdSecret = env("WORKDAY_CLIENT_SECRET") ?? env("ADAPTIVE_CLIENT_SECRET");
  const wdRefresh = env("WORKDAY_REFRESH_TOKEN") ?? env("ADAPTIVE_REFRESH_TOKEN");
  const wdTokenUrl = env("WORKDAY_TOKEN_URL") ?? env("ADAPTIVE_TOKEN_URL");
  const wdExchange = env("WORKDAY_TOKEN_EXCHANGE_URL") ?? env("ADAPTIVE_TOKEN_EXCHANGE_URL");
  const wdApi = env("WORKDAY_BASE_URL") ?? env("ADAPTIVE_API_URL");
  const bambooDomain = env("BAMBOOHR_DOMAIN");
  const bambooKey = env("BAMBOOHR_API_KEY");

  return {
    port: Number(env("REVDEMO_PORT") ?? 3001),
    databaseUrl: resolveDatabaseUrl(),
    // A reserved example domain by default. These addresses end up on permanent records in a real
    // HRIS, so the default must not look like a deliverable corporate address.
    emailDomain: env("REVDEMO_EMAIL_DOMAIN") ?? "workday-import.example.com",
    maxPerRequest: Number(env("REVDEMO_MAX_PER_REQUEST") ?? 1),
    workdayPollMs: Number(env("REVDEMO_WORKDAY_POLL_MS") ?? 30_000),

    // Striim owns the Postgres->Postgres hop in the full topology. It is reported rather than
    // driven from here: this app does not start or stop a Striim application.
    striimMode: (env("REVDEMO_STRIIM_MODE")?.toLowerCase() === "live" ? "live" : "mock"),
    targetDatabaseUrl: env("REVDEMO_TARGET_DATABASE_URL") ?? env("TARGET_DATABASE_URL"),
    striimWaitMs: Number(env("REVDEMO_STRIIM_WAIT_MS") ?? 60_000),
    striimApp: env("REVDEMO_STRIIM_APP") ?? "ReverseDemoCDC",
    striimNote: env("REVDEMO_STRIIM_MODE")?.toLowerCase() === "live"
      ? "log-based CDC (wal2json) replicating revdemo.employees between two databases — "
        + "no polling floor, measured under 15s"
      : "in-process transform — set REVDEMO_STRIIM_MODE=live to route through the real Striim app",

    workday: {
      ...resolve("workday", {
        WORKDAY_CLIENT_ID: wdClientId, WORKDAY_CLIENT_SECRET: wdSecret,
        WORKDAY_REFRESH_TOKEN: wdRefresh, WORKDAY_TOKEN_URL: wdTokenUrl,
        WORKDAY_TOKEN_EXCHANGE_URL: wdExchange, WORKDAY_BASE_URL: wdApi,
      }),
      apiUrl: wdApi, tokenUrl: wdTokenUrl, tokenExchangeUrl: wdExchange,
      clientId: wdClientId, clientSecret: wdSecret, refreshToken: wdRefresh,
      version: env("ADAPTIVE_VERSION"), instanceCode: env("ADAPTIVE_INSTANCE_CODE"),
      sheetName: env("ADAPTIVE_SHEET_NAME") ?? "EUPTD - Employee Demographics",
      importKey: env("ADAPTIVE_IMPORT_KEY") ?? "EmpID_EUPTD",
      levelCode: env("ADAPTIVE_LEVEL_CODE") ?? "SUPERVISORY_Workforce_Planning_Department",
      account: env("REVDEMO_WORKDAY_ACCOUNT") ?? "EUPTD_Demographics.PayRate",
      readMonth: env("REVDEMO_READ_MONTH") ?? "",
    },

    bamboohr: {
      ...resolve("bamboohr", { BAMBOOHR_DOMAIN: bambooDomain, BAMBOOHR_API_KEY: bambooKey }),
      domain: bambooDomain, apiKey: bambooKey,
    },
  };
}

export function publicReverseConfig(c: ReverseConfig) {
  const label = (() => {
    try {
      const u = new URL(c.databaseUrl);
      return `${u.host}${u.pathname}`;
    } catch { return "unknown"; }
  })();
  return {
    database: label,
    emailDomain: c.emailDomain,
    maxPerRequest: c.maxPerRequest,
    workdayPollMs: c.workdayPollMs,
    systems: {
      workday: { mode: c.workday.mode, reason: c.workday.reason, target: c.workday.sheetName },
      striim: { mode: c.striimMode, target: c.striimNote },
      postgres: { mode: "live" as const, target: label },
      bamboohr: {
        mode: c.bamboohr.mode, reason: c.bamboohr.reason,
        target: c.bamboohr.mode === "live" ? (c.bamboohr.domain ?? "") : "in-process mock",
      },
    },
  };
}
