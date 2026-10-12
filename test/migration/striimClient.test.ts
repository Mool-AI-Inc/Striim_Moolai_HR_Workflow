/** @lifespan THROWAWAY — unit tier; stubs global fetch, no Striim needed.
 *
 * The client's whole job is a fussy transport, so this asserts the exact headers and body
 * shape. A JSON body returns 415 and a STRIIM-TOKEN header returns 401, and both look like
 * "the command didn't work" rather than "you called it wrong" — which is why it is pinned.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { StriimClient, StriimError } from "../../src/platform/migration/striimClient.js";

const OPTS = {
  baseUrl: "http://striim.test:9080", user: "u", pass: "p",
  namespace: "instant_teams", deploymentGroup: "instant_teams_dg", slot: "s",
};

interface Stubbed { status?: number; body: unknown }

function stubFetch(...responses: Stubbed[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      json: async () => r.body, text: async () => text,
    };
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const headersOf = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>;

afterEach(() => { vi.unstubAllGlobals(); });

describe("StriimClient", () => {
  it("authenticates with form-encoded credentials and keeps the token", async () => {
    const calls = stubFetch({ body: { token: "tok-1" } });
    const c = new StriimClient(OPTS);
    expect(await c.authenticate()).toBe("tok-1");
    expect(calls[0].url).toBe("http://striim.test:9080/security/authenticate");
    expect(String(calls[0].init.body)).toContain("username=u");
    expect(String(calls[0].init.body)).toContain("password=p");
  });

  it("sends console statements as text/plain with an Authorization: token header", async () => {
    const calls = stubFetch({ body: { token: "tok-1" } }, { body: [{ executionStatus: "Success" }] });
    const c = new StriimClient(OPTS);
    await c.console("LIST APPLICATIONS;");
    const call = calls[1];
    expect(call.url).toBe("http://striim.test:9080/api/v2/tungsten");
    expect(headersOf(call.init)["Content-Type"]).toBe("text/plain");
    expect(headersOf(call.init).Authorization).toBe("token tok-1");
    expect(call.init.body).toBe("LIST APPLICATIONS;");
  });

  it("re-authenticates once on a 401 and retries", async () => {
    const calls = stubFetch(
      { body: { token: "tok-1" } },
      { status: 401, body: {} },
      { body: { token: "tok-2" } },
      { body: [{ executionStatus: "Success" }] },
    );
    const c = new StriimClient(OPTS);
    await c.console("LIST APPLICATIONS;");
    expect(calls).toHaveLength(4);
    expect(headersOf(calls[3].init).Authorization).toBe("token tok-2");
  });

  it("gives up rather than looping when the retry also fails", async () => {
    stubFetch({ body: { token: "t" } }, { status: 401, body: {} },
              { body: { token: "t2" } }, { status: 401, body: {} });
    const c = new StriimClient(OPTS);
    await expect(c.console("LIST APPLICATIONS;")).rejects.toThrow(StriimError);
  });

  it("qualifies a bare application name with the namespace, and leaves a qualified one alone", () => {
    const c = new StriimClient(OPTS);
    expect(c.qualify("InstantTeamsCDC")).toBe("instant_teams.InstantTeamsCDC");
    expect(c.qualify("other_ns.App")).toBe("other_ns.App");
  });

  it("reports UNKNOWN rather than throwing when the cluster will not say", async () => {
    stubFetch({ body: { token: "t" } }, { body: [{ executionStatus: "Success", output: {} }] });
    const c = new StriimClient(OPTS);
    expect(await c.appState("App")).toBe("UNKNOWN");
  });

  it("deploys into the configured group when the cluster says it is not deployed", async () => {
    // Deploy is NOT unconditional: a STOPPED application is already deployed and DEPLOY on
    // it is refused. So START is tried first and DEPLOY only happens when Striim asks for it.
    const calls = stubFetch(
      { body: { token: "t" } },
      { body: [{ executionStatus: "Success", output: { status: "CREATED" } }] },      // appState
      { body: [{ executionStatus: "Failure", failureMessage: "Application is not deployed. Please deploy the application first" }] },
      { body: [{ executionStatus: "Success" }] },                                     // DEPLOY
      { body: [{ executionStatus: "Success" }] },                                     // START (retry)
    );
    const c = new StriimClient(OPTS);
    await c.start("App");
    const bodies = calls.map((x) => String(x.init.body ?? ""));
    expect(bodies.filter((b) => b.startsWith("START APPLICATION"))).toHaveLength(2);
    expect(bodies).toContain("DEPLOY APPLICATION instant_teams.App IN instant_teams_dg;");
  });

  it("does NOT deploy a STOPPED application — it is already deployed", async () => {
    const calls = stubFetch(
      { body: { token: "t" } },
      { body: [{ executionStatus: "Success", output: { status: "STOPPED" } }] },
      { body: [{ executionStatus: "Success" }] },     // START succeeds straight away
    );
    const c = new StriimClient(OPTS);
    await c.start("App");
    expect(calls.map((x) => String(x.init.body ?? "")).some((b) => b.startsWith("DEPLOY"))).toBe(false);
  });

  it("resumes a HALTed application instead of trying to start it", async () => {
    // A HALTed application refuses BOTH stop and start; RESUME is the only way out.
    const calls = stubFetch(
      { body: { token: "t" } },
      { body: [{ executionStatus: "Success", output: { status: "HALT" } }] },
      { body: [{ executionStatus: "Success" }] },   // RESUME succeeds
    );
    const c = new StriimClient(OPTS);
    await c.start("App");
    const bodies = calls.map((x) => String(x.init.body ?? ""));
    expect(bodies.some((b) => b === "RESUME APPLICATION instant_teams.App;")).toBe(true);
    expect(bodies.some((b) => b.startsWith("START APPLICATION"))).toBe(false);
  });

  it("does not restart an application that is already running", async () => {
    const calls = stubFetch(
      { body: { token: "t" } },
      { body: [{ executionStatus: "Success", output: { status: "RUNNING" } }] },
    );
    const c = new StriimClient(OPTS);
    await c.start("App");
    expect(calls.map((x) => String(x.init.body ?? "")).some((b) => b.includes("START"))).toBe(false);
  });
});
