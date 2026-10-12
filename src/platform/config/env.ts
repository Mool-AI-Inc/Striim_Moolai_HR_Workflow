/**
 * Environment config — the ONE place PLATFORM_MODE fans out into every base URL + credential.
 * @lifespan PRODUCTION — the single live-ness switch. No other module reads PLATFORM_MODE directly.
 * @responsibility demo → every vendor base URL is the simulator + placeholder creds + the committed fixture;
 *   live → each base URL + credential comes from its own env var and must be present.
 */
export type PlatformMode = "demo" | "live";

/** memory = approvals + ledger stay in-process (the default; no Docker, no Postgres).
 *  pg     = they go to Postgres, which is the database the migration actually moves. */
export type LedgerMode = "memory" | "pg";

export interface PaylocityEnv { baseUrl: string; clientId: string; clientSecret: string; }
export interface PostmarkEnv { baseUrl: string; serverToken: string; from: string; }
export interface VendorEnv { baseUrl: string; token: string; }
export interface StriimEnv {
  baseUrl: string; user: string; pass: string; namespace: string;
  deploymentGroup: string; slot: string;
}

export interface Env {
  mode: PlatformMode;
  simulatorUrl: string;
  ledgerDatabaseUrl: string;
  /** Where the migration is copying TO. The cutover points ledgerDatabaseUrl at this. */
  targetDatabaseUrl: string;
  ledgerMode: LedgerMode;
  striim: StriimEnv;
  temporalAddress: string;
  paylocity: PaylocityEnv;
  postmark: PostmarkEnv;
  sms: VendorEnv;
  slack: VendorEnv;
  vetty: VendorEnv;
  workbright: VendorEnv;
  drive: VendorEnv;
  anthropicApiKey?: string;
  uc6Model?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env ${name} (PLATFORM_MODE=live)`);
  return v;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const mode: PlatformMode = env.PLATFORM_MODE === "live" ? "live" : "demo";
  const sim = env.SIMULATOR_URL ?? "http://127.0.0.1:8085";
  // demo: every vendor URL is the simulator, creds are throwaway. live: required from each var.
  const url = (liveVar: string): string => (mode === "demo" ? sim : required(env, liveVar));
  const cred = (liveVar: string): string => (mode === "demo" ? "demo" : required(env, liveVar));
  return {
    mode,
    simulatorUrl: sim,
    ledgerDatabaseUrl: env.LEDGER_DATABASE_URL ?? "postgres://instant:instant@127.0.0.1:5433/instant_ledger",
    targetDatabaseUrl: env.TARGET_DATABASE_URL ?? "",
    ledgerMode: env.LEDGER_MODE === "pg" ? "pg" : "memory",
    striim: {
      baseUrl: env.STRIIM_URL ?? "https://developer.striim.com",
      user: env.STRIIM_USER ?? "",
      pass: env.STRIIM_PASS ?? "",
      namespace: env.STRIIM_MIGRATION_NS ?? "sarah_moolai",
      // There is no deployment group called "default" on this cluster; DEPLOY without
      // an explicit one fails. `LIST DEPLOYMENTGROUPS;` gives the real name.
      deploymentGroup: env.STRIIM_DEPLOYMENT_GROUP ?? "sarah_moolai_dg",
      slot: env.MIGRATION_SLOT ?? "instant_teams_slot",
    },
    temporalAddress: env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    paylocity: { baseUrl: url("PAYLOCITY_BASE_URL"), clientId: cred("PAYLOCITY_CLIENT_ID"), clientSecret: cred("PAYLOCITY_CLIENT_SECRET") },
    postmark: { baseUrl: url("POSTMARK_BASE_URL"), serverToken: cred("POSTMARK_SERVER_TOKEN"), from: env.POSTMARK_FROM ?? "hr@instant.test" },
    sms: { baseUrl: url("SMS_BASE_URL"), token: cred("SMS_TOKEN") },
    slack: { baseUrl: url("SLACK_BASE_URL"), token: cred("SLACK_TOKEN") },
    vetty: { baseUrl: url("VETTY_BASE_URL"), token: cred("VETTY_TOKEN") },
    workbright: { baseUrl: url("WORKBRIGHT_BASE_URL"), token: cred("WORKBRIGHT_TOKEN") },
    drive: { baseUrl: url("DRIVE_BASE_URL"), token: cred("DRIVE_TOKEN") },
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    uc6Model: env.UC6_MODEL,
  };
}
