/**
 * Paylocity (Weblink) connector — HRIS read + webhook auth + new-hire staging.
 * @lifespan PRODUCTION — the shared HRIS connector; demo points it at the simulator, live at api.paylocity.com.
 * @responsibility Cache a client-credentials bearer, read employees (0-based pagination via X-Pcty-Total-Count),
 *   verify Basic-auth webhooks, and stage a new hire (UC3 finalize).
 *
 * Weblink family (base host api.paylocity.com) — do NOT cross-wire with the API Hub gateway.
 */
import type { HrisReadConnector } from "../types.js";
import type { EmployeeRecord } from "../../domain/types.js";

export interface PaylocityConfig { baseUrl: string; clientId: string; clientSecret: string; }

/** Staging input for createEmployeeStaging — `companyId` selects the Weblink company; the rest is the new hire. */
export interface EmployeeStagingInput {
  companyId: string;
  firstName?: string; lastName?: string; email?: string;
  birthDate?: string; hireDate?: string; costCenter?: string; phone?: string; smsConsent?: boolean;
}

export class PaylocityConnector implements HrisReadConnector {
  private token?: { value: string; expiresAt: number };
  constructor(private readonly cfg: PaylocityConfig) {}

  /** Client-credentials bearer, cached until 30s before expiry. */
  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await fetch(`${this.cfg.baseUrl}/IdentityServer/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
    });
    if (!res.ok) throw new Error(`paylocity token failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.bearer()}` };
  }

  async getEmployee(companyId: string, employeeId: string): Promise<EmployeeRecord> {
    const res = await fetch(`${this.cfg.baseUrl}/api/v2/companies/${companyId}/employees/${employeeId}`, { headers: await this.authHeaders() });
    if (res.status === 404) throw new Error(`employee not found: ${employeeId}`);
    if (!res.ok) throw new Error(`paylocity getEmployee failed: ${res.status}`);
    return (await res.json()) as EmployeeRecord;
  }

  async listEmployees(companyId: string): Promise<EmployeeRecord[]> {
    const pagesize = 25;
    const out: EmployeeRecord[] = [];
    let total = Infinity;  // discovered from X-Pcty-Total-Count on the first page
    for (let pagenumber = 0; out.length < total; pagenumber++) {
      const url = `${this.cfg.baseUrl}/api/v2/companies/${companyId}/employees?pagesize=${pagesize}&pagenumber=${pagenumber}&includetotalcount=true`;
      const res = await fetch(url, { headers: await this.authHeaders() });
      if (!res.ok) throw new Error(`paylocity listEmployees failed: ${res.status}`);
      total = Number(res.headers.get("x-pcty-total-count") ?? 0);
      const page = (await res.json()) as EmployeeRecord[];
      out.push(...page);
      if (page.length === 0) break;  // guard: a page shorter than expected total ends the loop
    }
    return out;
  }

  /** Basic-auth check for the Paylocity webhook (no HMAC is sent — Basic Auth is the app-layer check). */
  verifyWebhookAuth(header: string | undefined): boolean {
    const expected = "Basic " + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    return header === expected;
  }

  /** Weblink "Create New Employee" staging (UC3 finalize calls this via an activity). */
  async createEmployeeStaging(payload: EmployeeStagingInput): Promise<{ employeeId: string }> {
    const { companyId, ...rest } = payload;
    const res = await fetch(`${this.cfg.baseUrl}/api/v2/companies/${companyId}/employees`, {
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": "application/json" },
      body: JSON.stringify(rest),
    });
    if (!res.ok) throw new Error(`paylocity staging failed: ${res.status}`);
    return (await res.json()) as { employeeId: string };
  }
}
