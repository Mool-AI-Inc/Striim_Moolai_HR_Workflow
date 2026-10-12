/**
 * Striim REST console transport.
 * @lifespan PRODUCTION — the only thing in the app that talks to Striim.
 * @responsibility Authenticate, run console statements, read and change application state.
 *
 * The calling convention here is NOT what Striim's documentation describes. It is what was
 * measured against this cluster (and recorded in the Striim agent repo's FINDINGS.md §1):
 *
 *   POST /security/authenticate   form-encoded            -> { token }
 *   POST /api/v2/tungsten         text/plain body, header  Authorization: token <value>
 *
 * A JSON body returns 415. A `STRIIM-TOKEN` header returns 401. Both failures look like
 * "the command didn't work" rather than "you called it wrong", which is why this is a
 * class with tests rather than a fetch inlined at the call site.
 */
import type { StriimEnv } from "../config/env.js";

/** Striim answers 200 with the failure inside the body, so this shape matters. */
export interface ConsoleResult {
  command?: string;
  executionStatus?: string;
  failureMessage?: string;
  output?: unknown;
  responseCode?: number;
}

export class StriimError extends Error {
  constructor(message: string, readonly statement: string) {
    super(message);
    this.name = "StriimError";
  }
}

export class StriimClient {
  private token: string | undefined;

  constructor(private readonly opts: StriimEnv) {}

  async authenticate(): Promise<string> {
    const body = new URLSearchParams({ username: this.opts.user, password: this.opts.pass });
    const r = await fetch(`${this.opts.baseUrl}/security/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) throw new StriimError(`authenticate failed: HTTP ${r.status}`, "authenticate");
    const json = (await r.json()) as { token?: string };
    if (!json.token) throw new StriimError("authenticate returned no token", "authenticate");
    this.token = json.token;
    return json.token;
  }

  /** Run one console statement. Re-authenticates ONCE on a 401, then gives up. */
  async console(statement: string): Promise<ConsoleResult[]> {
    if (!this.token) await this.authenticate();
    let r = await this.post(statement);
    if (r.status === 401) {
      await this.authenticate();
      r = await this.post(statement);
    }
    const text = await r.text();
    if (!r.ok) throw new StriimError(`HTTP ${r.status}: ${text.slice(0, 500)}`, statement);
    let parsed: ConsoleResult[];
    try {
      parsed = JSON.parse(text) as ConsoleResult[];
    } catch {
      return [{ command: statement, executionStatus: "Success", output: text }];
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  private post(statement: string): Promise<Response> {
    return fetch(`${this.opts.baseUrl}/api/v2/tungsten`, {
      method: "POST",
      headers: { Authorization: `token ${this.token ?? ""}`, "Content-Type": "text/plain" },
      body: statement,
    });
  }

  /** Bare name -> namespace-qualified. Already-qualified names pass through. */
  qualify(app: string): string {
    return app.includes(".") ? app : `${this.opts.namespace}.${app}`;
  }

  /**
   * Current application state.
   *
   * Returns "UNKNOWN" rather than throwing when the cluster will not say. Callers that
   * gate a destructive step on this MUST treat UNKNOWN as "still running" — see cutover.
   */
  async appState(app: string): Promise<string> {
    const result = await this.console(`STATUS ${this.qualify(app)};`);
    const output = result[0]?.output as { status?: string } | undefined;
    return output?.status ?? "UNKNOWN";
  }

  async start(app: string): Promise<void> {
    const name = this.qualify(app);
    const state = await this.appState(app);
    if (state === "RUNNING") return;

    // A HALTed application refuses BOTH stop and start; RESUME is the only way out. If the
    // cause has not cleared, RESUME fails too and UNDEPLOY drops it back to CREATED.
    if (state === "HALT") {
      if (ok(await this.console(`RESUME APPLICATION ${name};`))) return;
      await this.console(`UNDEPLOY APPLICATION ${name};`);
    }

    // Deploying is NOT unconditional. The states divide cleanly:
    //   CREATED   -> needs DEPLOY; START alone says "not deployed"
    //   STOPPED   -> already deployed; DEPLOY says "Cannot deploy because ... is Stopped"
    // Rather than encode a table that the next Striim version can invalidate, try the
    // start, and deploy only if the cluster says that is what is missing.
    let started = await this.console(`START APPLICATION ${name};`);
    if (!ok(started) && /not deployed|deploy the application/i.test(failure(started))) {
      // DEPLOY without an explicit group fails with "cannot find such deployment group:
      // default" — there is no group by that name on this cluster.
      const deployed = await this.console(`DEPLOY APPLICATION ${name} IN ${this.opts.deploymentGroup};`);
      if (!ok(deployed)) throw new StriimError(failure(deployed), `DEPLOY ${name}`);
      started = await this.console(`START APPLICATION ${name};`);
    }
    if (!ok(started)) throw new StriimError(failure(started), `START ${name}`);
  }

  async stop(app: string): Promise<void> {
    const name = this.qualify(app);
    const state = await this.appState(app);
    if (state === "STOPPED" || state === "CREATED" || state === "COMPLETED") return;
    const result = await this.console(`STOP APPLICATION ${name};`);
    if (!ok(result)) throw new StriimError(failure(result), `STOP ${name}`);
  }
}

function ok(result: ConsoleResult[]): boolean {
  return !result.some((r) => r.executionStatus === "Failure");
}

function failure(result: ConsoleResult[]): string {
  return result.find((r) => r.executionStatus === "Failure")?.failureMessage?.trim() ?? "unknown failure";
}
