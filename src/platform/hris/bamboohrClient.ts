/**
 * BambooHR REST client.
 * @lifespan PRODUCTION — the write path into a customer's HRIS.
 * @responsibility Authenticate, create and update employees, write table rows, discover fields.
 *
 * This exists because Striim cannot write to BambooHR. Striim has 50 target adapters and four
 * of them are SaaS applications (Salesforce, Salesforce Marketing Cloud, ServiceNow,
 * Dataverse) — none is an HR system. The BambooHR Reader is a READER. So the inbound leg is
 * Striim's and this outbound leg is ours.
 *
 * Auth is HTTP Basic with the API key as the USERNAME and any string as the password. That is
 * not a typo in the docs; it is genuinely how BambooHR does it.
 *
 * Three behaviours worth knowing before reading the code:
 *
 *   503 + Retry-After   throttling. Honour the header rather than guessing a backoff.
 *   429                 the account's EMPLOYEE LIMIT is reached. Not a rate limit — a seat
 *                       cap. Retrying never fixes it, so it is raised, not retried.
 *   duplicate emails    rejected by BambooHR. Useful: email is effectively a natural key,
 *                       which is how we recover from an ambiguous create (see findByEmail).
 */

export interface BambooHROptions {
  /** The subdomain from the login URL, not a full URL. */
  domain: string;
  apiKey: string;
  /** Overridable for tests. */
  baseUrl?: string;
  maxRetries?: number;
}

export class BambooHRError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "BambooHRError";
  }
}

/** Raised when the account cannot hold more employees. Retrying is pointless. */
export class SeatLimitReached extends BambooHRError {
  constructor(message: string) {
    super(message, 429, false);
    this.name = "SeatLimitReached";
  }
}

export interface EmployeeFields { [field: string]: string | number | boolean | null }

export class BambooHRClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly maxRetries: number;

  constructor(private readonly opts: BambooHROptions) {
    this.base = opts.baseUrl ?? `https://api.bamboohr.com/api/gateway.php/${opts.domain}/v1`;
    // API key as username, any string as password. Base64, no colon in the key.
    this.auth = "Basic " + Buffer.from(`${opts.apiKey}:x`).toString("base64");
    this.maxRetries = opts.maxRetries ?? 4;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const r = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (r.status === 429) {
        // The seat cap. A different thing from throttling, and retrying cannot help.
        throw new SeatLimitReached(
          `BambooHR account has reached its employee limit — no more employees can be added `
          + `(${method} ${path}). Raise the plan's seat count before continuing.`,
        );
      }

      if (r.status === 503 && attempt < this.maxRetries) {
        // Honour Retry-After when BambooHR sends it; fall back to exponential.
        const after = Number(r.headers.get("retry-after"));
        const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 1000;
        await new Promise((res) => setTimeout(res, waitMs));
        attempt += 1;
        continue;
      }

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new BambooHRError(
          `BambooHR ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`,
          r.status,
          r.status >= 500,
        );
      }
      return r;
    }
  }

  /**
   * Create an employee. Minimum is firstName + lastName.
   *
   * The new id arrives in the Location header, NOT the body — which is why this returns the
   * id rather than a parsed response, and why losing the response to a timeout is the
   * dangerous case this class is shaped around.
   */
  async createEmployee(fields: EmployeeFields): Promise<string> {
    const r = await this.request("POST", "/employees/", fields);
    const location = r.headers.get("location") ?? "";
    const id = location.split("/").filter(Boolean).pop();
    if (!id) {
      throw new BambooHRError(
        "BambooHR created the employee but returned no id in the Location header — "
        + "resolve by email before retrying or you will create a duplicate person.",
        r.status, false,
      );
    }
    return id;
  }

  async updateEmployee(id: string, fields: EmployeeFields): Promise<void> {
    await this.request("POST", `/employees/${encodeURIComponent(id)}`, fields);
  }

  /**
   * Append a row to one of an employee's tables — jobInfo, compensation, employmentStatus.
   *
   * THIS is why a migrated employee is not one API call. The core record holds names and
   * contact details; role, pay and employment status are row-based history in separate
   * tables. A person is only fully migrated once their tables are populated too, and a
   * failure between the two leaves a real employee present but unpaid.
   *
   * TWO WAYS THIS 400s, BOTH WITH AN EMPTY BODY AND NO ERROR MESSAGE. Measured on a live
   * account, and neither is guessable from the response:
   *
   *   1. A row carrying only `date` is rejected. It needs at least one content field.
   *   2. LIST fields — jobTitle, department, division, location — only accept values that
   *      ALREADY EXIST in that BambooHR account. "HR Administrator" succeeded;
   *      "Integration Test" got a bare 400. You cannot invent a job title on the way in.
   *
   * For a real migration that second one is a planning item, not a detail: every distinct
   * job title, department, division and location in the source has to exist in the target
   * first, or those rows fail one at a time with no explanation.
   */
  async addTableRow(id: string, table: string, row: EmployeeFields): Promise<void> {
    // The path has a /tables/ segment. Without it BambooHR answers
    // 404 {"error_msg":"404 Route Not Found"} — which reads like a bad employee id rather
    // than a bad route, and cost a debugging round to find.
    await this.request(
      "POST",
      `/employees/${encodeURIComponent(id)}/tables/${encodeURIComponent(table)}`,
      row,
    );
  }

  /** Every writable field name. Run this before mapping anything — do not guess field names. */
  async listFields(): Promise<unknown> {
    const r = await this.request("GET", "/meta/fields/");
    return r.json();
  }

  /**
   * Every employee, via the custom-report endpoint.
   *
   * NOT /employees/directory. The directory is an incomplete index and using it here is a
   * correctness bug, measured on a live account: the directory returned 91 employees while
   * the report returned 110. It hides terminated and inactive people — AND it hides a
   * freshly created employee whose hireDate is still 0000-00-00, which is exactly the
   * employee an ambiguous-create recovery needs to find.
   *
   * Using the directory for findByEmail therefore answers "not found" for someone who
   * exists, and the caller then creates a DUPLICATE PERSON with a duplicate payroll record.
   * The report is the only trustworthy index.
   */
  private async allEmployees(): Promise<{ id: string; workEmail?: string }[]> {
    const r = await this.request("POST", "/reports/custom?format=JSON", {
      title: "moolai-index",
      fields: ["id", "workEmail"],
    });
    const body = (await r.json()) as { employees?: { id: string; workEmail?: string }[] };
    return body.employees ?? [];
  }

  /**
   * How many employees the account holds — the seat-limit preflight.
   *
   * BambooHR answers 429 "employee limit reached" once an account is full, and finding that
   * out at employee 180 of 200 is the bad way to learn it.
   */
  async directorySize(): Promise<number> {
    return (await this.allEmployees()).length;
  }

  /**
   * Find an employee by email.
   *
   * The recovery path for an ambiguous create: if a POST timed out we cannot know whether the
   * employee landed, and BambooHR rejects duplicate emails, so email is a usable natural key.
   * Look them up before retrying rather than risking a second person.
   */
  async findByEmail(email: string): Promise<string | undefined> {
    const hits = (await this.allEmployees()).filter(
      (e) => (e.workEmail ?? "").toLowerCase() === email.toLowerCase());
    return hits[0]?.id;
  }

  /** How many employees carry this email. More than one is a duplicate — the thing we prevent. */
  async countByEmail(email: string): Promise<number> {
    return (await this.allEmployees()).filter(
      (e) => (e.workEmail ?? "").toLowerCase() === email.toLowerCase()).length;
  }
}
