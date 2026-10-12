/**
 * Workday Adaptive Planning client — the write path for beat 2.
 * @lifespan PRODUCTION — pushes migrated employees into an Adaptive modeled sheet.
 * @responsibility The two-hop OAuth chain, and one importConfigurableModelData call.
 *
 * WHY THIS IS OURS AND NOT STRIIM'S
 *
 * Checked against the live cluster: of 364 adapters, `WorkdayReader` is the ONLY
 * Workday-related one, and of 50 writers exactly three are SaaS applications — Salesforce,
 * Dynamics 365, Dynamics 365 Business Central. There is no Workday or Adaptive writer in
 * either direction. So Striim reads the HRIS and moves the ledger; this leg is ours.
 *
 * AUTH IS TWO HOPS, NOT ONE
 *
 *   1. POST refresh_token + client_id/secret to Workday's OAuth endpoint -> access_token
 *   2. GET Workday's adaptiveAPIAccessToken with that bearer      -> Adaptive publicAPIToken
 *
 * Only the second token talks to Adaptive, and it goes in the XML body as
 * <credentials token="..."/>, not in a header. The token lives at data[0].publicAPIToken —
 * not at the top level, which is easy to get wrong and yields a 4-character string.
 *
 * ADAPTIVE IS NOT A RECORD STORE
 *
 * You do not insert an employee. You write a VALUE into a cell addressed by
 * account x level x dimensions x time period, as a pipe-delimited row matching the sheet's
 * IMPORT TEMPLATE. The import template's column names are not the same as the export CSV's
 * labels — "Account Name" and "Account Code" are rejected outright. This is why the sheet
 * and its headers have to be known before a single write is attempted.
 */

export interface AdaptiveOptions {
  apiUrl: string;            // https://api.adaptiveplanning.com/api/v40
  tokenUrl: string;          // Workday OAuth token endpoint
  tokenExchangeUrl: string;  // Workday -> Adaptive token exchange
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  version: string;           // e.g. "Pay Transparency v1"
  instanceCode?: string;
  /** The modeled sheet to write into. Must already exist in Adaptive. */
  sheetName: string;
  /** Column used to match a row to an existing employee. */
  importKey?: string;
  /**
   * Level the rows belong to — the INTERNAL code, not the display name.
   *
   * The most expensive mistake available here. The display name "Workforce Planning Department" is
   * rejected with "Invalid Level Choice: ... on row 1 column A"; the internal code
   * "SUPERVISORY_Workforce_Planning_Department" is accepted. exportData with
   * useInternalCodes="true" is where the real value comes from — it is the third CSV column.
   */
  level: string;
  /**
   * Send only Level|importKey|metric|month, omitting the demographic dimension columns.
   *
   * Defaults to TRUE, matching adaptive_modeled_import_minimal_row in the working
   * WorkdayAdaptiveAgent, and it is the difference between a write and six rejections. The
   * nine-column form asks Adaptive to match members for Gender, Location, Job_Group,
   * Job_Classification and Worker_Name — and the EUPTD export carries literal placeholder strings
   * ("Job_Group", "Job_Classification") for two of them, so those members do not exist and the
   * whole row is refused. Verified against the live tenant:
   *   9 columns -> "dimension values for Location ... do not exist: Salt Lake City, Utah" (x6)
   *   4 columns -> "import successful. Import rows processed: 1, Adaptive rows updated: 1"
   */
  minimalRow?: boolean;
}

/** One employee's worth of cells to write. */
export interface AdaptiveRow {
  employeeId: string;
  workerName: string;
  /** MM/YYYY — Adaptive addresses values by period. */
  month: string;
  /** The metric column on the sheet, e.g. "Pay Rate". */
  metricColumn: string;
  value: number;
  /** Extra dimension columns, in the order the sheet's import template expects them. */
  dimensions?: Record<string, string>;
}

export class AdaptiveError extends Error {
  constructor(message: string) { super(message); this.name = "AdaptiveError"; }
}

/** Adaptive rejects pipes and newlines inside a cell; they would break the row. */
function cell(v: string | number): string {
  return String(v ?? "").replace(/[|\r\n]+/g, " ").trim();
}

function xmlText(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
          .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class AdaptiveClient {
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(private readonly opts: AdaptiveOptions) {}

  /** The two-hop chain, cached for the session Adaptive grants us. */
  async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.opts.refreshToken,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    const r1 = await fetch(this.opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!r1.ok) {
      throw new AdaptiveError(`Workday OAuth -> ${r1.status}: ${(await r1.text()).slice(0, 200)}`);
    }
    const accessToken = ((await r1.json()) as { access_token?: string }).access_token;
    if (!accessToken) throw new AdaptiveError("Workday OAuth returned no access_token");

    const r2 = await fetch(this.opts.tokenExchangeUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!r2.ok) {
      throw new AdaptiveError(`Adaptive token exchange -> ${r2.status}: ${(await r2.text()).slice(0, 200)}`);
    }
    // The token is nested. data[0].publicAPIToken, not a top-level field.
    const body = (await r2.json()) as { data?: { publicAPIToken?: string; sessionTimeout?: number }[] };
    const first = body.data?.[0];
    if (!first?.publicAPIToken) {
      throw new AdaptiveError("Adaptive token exchange returned no publicAPIToken at data[0]");
    }
    this.token = first.publicAPIToken;
    // Expire five minutes early rather than discovering staleness mid-write.
    this.tokenExpiresAt = Date.now() + ((first.sessionTimeout ?? 30) * 60 - 300) * 1000;
    return this.token;
  }

  /**
   * Build the importConfigurableModelData request.
   *
   * Exposed separately from send() so a dry run can show the operator the exact bytes before
   * anything touches a live planning model. Writing into Adaptive changes numbers people
   * report on, so "show me first" is the correct default.
   */
  buildImportXml(rows: AdaptiveRow[], token = "DRY-RUN-NO-TOKEN"): string {
    const first = rows[0];
    if (!first) throw new AdaptiveError("no rows to import");

    // Column order and names are NOT invented. They are the header the MoolAI Adaptive agent
    // already writes successfully to this instance:
    //   Level|Gender|Location|Job_Group|Job_Classification|Worker_Name|EmpID_EUPTD|<metric>|<MM/YYYY>
    // The agent's own comment records why this cannot be guessed: "Headers must match the
    // sheet's import template (modeled columns), not exportData CSV labels — e.g.
    // 'Account Name' / 'Account Code' are rejected by the API."
    // minimalRow (the default) drops the five demographic columns. See the option's doc comment:
    // the nine-column form is rejected six times over because the EUPTD export carries literal
    // placeholder members for Job_Group and Job_Classification, so Adaptive is asked to match
    // dimension values that do not exist. Four columns is what actually writes.
    const key = this.opts.importKey ?? "EmpID_EUPTD";
    const minimal = this.opts.minimalRow !== false;
    const dimOrder = minimal
      ? []
      : ["Gender", "Location", "Job_Group", "Job_Classification", "Worker_Name"];
    const header = ["Level", ...dimOrder, key, first.metricColumn, first.month].join("|");

    // Note the trailing empty field on each row: the value sits in the METRIC column and the
    // period column is left blank. That is how the working agent builds it, and it is the
    // shape Adaptive expects for a plan version.
    const lines = rows.map((r) => [
      cell(this.opts.level),
      ...dimOrder.map((d) => cell(d === "Worker_Name" ? r.workerName : (r.dimensions?.[d] ?? ""))),
      cell(r.employeeId),
      cell(Number.isInteger(r.value) ? String(r.value) : String(r.value)),
      "",
    ].join("|"));

    const instance = this.opts.instanceCode
      ? ` instanceCode="${xmlAttr(this.opts.instanceCode)}"` : "";
    const version = this.opts.version && this.opts.version !== "default"
      ? `<version name="${xmlAttr(this.opts.version)}" isDefault="false"/>`
      : `<version isDefault="true"/>`;

    // rowData carries NESTED <header> and <rows><row> elements, not a CDATA blob. Getting
    // that wrong fails quietly: Adaptive answers HTTP 200 with success="false".
    const rowXml = lines.map((l) => `    <row>${xmlText(l)}</row>`).join("\n");

    return [
      `<?xml version='1.0' encoding='UTF-8'?>`,
      `<call method="importConfigurableModelData" callerName="MoolaiHrisLoader">`,
      `  <credentials token="${xmlAttr(token)}"${instance}/>`,
      // replaceExisting=3 updates matched rows rather than appending duplicates — the same
      // idempotency concern as the BambooHR loader, in Adaptive's own vocabulary.
      `  <importDataOptions planOrActuals="Plan" allowParallel="false" moveBPtr="false"`,
      `                     useMappings="false" replaceExisting="3"`,
      `                     importKey="${xmlAttr(key)}"/>`,
      `  ${version}`,
      `  <sheet name="${xmlAttr(this.opts.sheetName)}" isUserAssigned="false"/>`,
      `  <rowData>`,
      `    <header>${xmlText(header)}</header>`,
      `    <rows>`,
      rowXml,
      `    </rows>`,
      `  </rowData>`,
      `</call>`,
    ].join("\n");
  }

  /** Send it for real. Only call this once a dry run has been read by a person. */
  async importRows(rows: AdaptiveRow[]): Promise<{ success: boolean; message: string }> {
    const token = await this.authenticate();
    const xml = this.buildImportXml(rows, token);
    const r = await fetch(this.opts.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });
    const text = await r.text();
    // Adaptive answers HTTP 200 with success="false" in the body, so the status code alone
    // says nothing — the same trap as Striim's console.
    const success = /success="true"/.test(text);
    // Collect EVERY <message>, not the first.
    //
    // The first match was the empty text node of the <messages> wrapper, so a failed import
    // reported `Adaptive rejected the import:` with nothing after the colon — which hid the
    // actual cause for twenty consecutive failures. Adaptive puts one <message key="..."> per
    // problem and the useful ones are the warnings naming which dimension value it does not
    // recognise, so they all matter.
    const messages = [...text.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)]
      .map((m) => (m[1] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const reason = messages.length
      ? messages.join(" | ")
      : text.replace(/\s+/g, " ").slice(0, 300);
    return { success, message: success ? "imported" : reason };
  }
}
