/**
 * Does every configured demo slot exist as an EmpID_EUPTD member in the Adaptive model?
 * @lifespan PRODUCTION — the preflight before a live demo, and after asking an admin for members.
 *
 *   npm run slots:check
 *
 * Read-only. It runs an exportData over the sheet and compares the EmpID_EUPTD values it finds
 * against ADAPTIVE_DEMO_SLOTS.
 *
 * WHY THIS IS WORTH A SCRIPT
 *
 * Adaptive cannot create dimension members through the API available to us — the only methods are
 * exportData, exportSheets and importConfigurableModelData. So a missing member is not something
 * the pipeline can fix at runtime; it fails the write with "dimension values for EmpID_EUPTD are
 * either not available for the sheet or do not exist". Finding that out during a demo is the worst
 * possible time, and the error names one member at a time. This names all of them at once.
 */
import { AdaptiveClient } from "../src/platform/hris/adaptiveClient.js";
import { configuredSlots } from "../src/syncdemo/server/slots.js";

const need = (n: string): string => {
  const v = process.env[n]?.trim();
  if (!v) throw new Error(`missing ${n}`);
  return v;
};

const SHEET = process.env.ADAPTIVE_SHEET_NAME?.trim() || "EUPTD - Employee Demographics";
const ACCOUNT = process.env.ADAPTIVE_SLOT_CHECK_ACCOUNT?.trim() || "EUPTD_Demographics.PayRate";
const MONTH = process.env.ADAPTIVE_WRITE_MONTH?.trim()
  || new Date().toISOString().slice(0, 7).split("-").reverse().join("/");

const xa = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function main(): Promise<void> {
  const slots = configuredSlots();
  if (slots.length === 0) {
    console.log("ADAPTIVE_DEMO_SLOTS is empty — nothing to check.");
    return;
  }

  const client = new AdaptiveClient({
    apiUrl: need("ADAPTIVE_API_URL"), tokenUrl: need("ADAPTIVE_TOKEN_URL"),
    tokenExchangeUrl: need("ADAPTIVE_TOKEN_EXCHANGE_URL"),
    clientId: need("ADAPTIVE_CLIENT_ID"), clientSecret: need("ADAPTIVE_CLIENT_SECRET"),
    refreshToken: need("ADAPTIVE_REFRESH_TOKEN"),
    version: process.env.ADAPTIVE_VERSION ?? "default",
    ...(process.env.ADAPTIVE_INSTANCE_CODE ? { instanceCode: process.env.ADAPTIVE_INSTANCE_CODE } : {}),
    level: process.env.ADAPTIVE_LEVEL_CODE ?? "", sheetName: SHEET,
    importKey: process.env.ADAPTIVE_IMPORT_KEY ?? "EmpID_EUPTD",
  });

  const token = await client.authenticate();
  const dims = ["Gender", "Location", "Job_Group", "Job_Classification", "Worker_Name", "EmpID_EUPTD"];
  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<call method="exportData" callerName="MoolaiSlotCheck">
  <credentials token="${xa(token)}" instanceCode="${xa(process.env.ADAPTIVE_INSTANCE_CODE ?? "")}"/>
  <version name="${xa(process.env.ADAPTIVE_VERSION ?? "")}" isDefault="false"/>
  <format useInternalCodes="true" includeUnmappedItems="false"/>
  <filters>
    <accounts><account code="${xa(ACCOUNT)}" isAssumption="false" includeDescendants="false"/></accounts>
    <timeSpan start="${xa(MONTH)}" end="${xa(MONTH)}"/>
  </filters>
  <dimensions>
${dims.map((d) => `    <dimension name="${xa(d)}"/>`).join("\n")}
  </dimensions>
  <rules includeZeroRows="true" includeRollupAccounts="false" includeRollupLevels="false" markInvalidValues="false">
    <currency useLocal="true"/>
  </rules>
</call>`;

  const r = await fetch(need("ADAPTIVE_API_URL"), {
    method: "POST", headers: { "Content-Type": "application/xml" }, body: xml,
  });
  const text = await r.text();
  if (!/success="true"/.test(text)) {
    throw new Error(`exportData failed: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
  }

  const csv = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(text)?.[1] ?? "";
  const lines = csv.trim().split("\n");
  // [Account Name, Account Code, Level Name, ...dims, ...months] — EmpID_EUPTD is the last dim.
  const empIdx = 3 + dims.indexOf("EmpID_EUPTD");
  const present = new Set(
    lines.slice(1)
      .map((l) => (l.split(",")[empIdx] ?? "").replace(/"/g, "").trim())
      .filter(Boolean));

  const found = slots.filter((s) => present.has(s));
  const missing = slots.filter((s) => !present.has(s));

  console.log(`sheet "${SHEET}" · account ${ACCOUNT} · period ${MONTH}`);
  console.log(`${present.size} EmpID_EUPTD members on the sheet\n`);
  console.log(`configured demo slots: ${slots.length}`);
  console.log(`  present: ${found.length}${found.length ? ` — ${found.join(", ")}` : ""}`);
  console.log(`  MISSING: ${missing.length}${missing.length ? ` — ${missing.join(", ")}` : ""}`);

  if (missing.length) {
    console.log(
      "\nThe missing members must be added to the EmpID_EUPTD dimension by an Adaptive admin.\n"
      + "The API available here cannot create them: only exportData, exportSheets and\n"
      + "importConfigurableModelData are in use, and none of those adds a dimension member.\n"
      + "Until they exist, the Workday stage will fail for those slots with\n"
      + '  "dimension values for EmpID_EUPTD ... do not exist"\n'
      + "and the slot will be left FAILED and retriable rather than silently marked synced.");
    process.exitCode = 1;   // so CI or a shell check can gate on it
  } else {
    console.log("\nAll configured slots exist. The Workday stage can write for real.");
  }
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
