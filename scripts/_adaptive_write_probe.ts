// TEMPORARY: prove a REAL Adaptive write using the shape the working agent uses.
// Writes back the value already in the cell, so it proves the mechanism without changing a number.
// Delete after use.
import { AdaptiveClient } from "../src/platform/hris/adaptiveClient.js";

const need = (n: string): string => {
  const v = process.env[n]?.trim();
  if (!v) throw new Error(`missing ${n}`);
  return v;
};

const client = new AdaptiveClient({
  apiUrl: need("ADAPTIVE_API_URL"), tokenUrl: need("ADAPTIVE_TOKEN_URL"),
  tokenExchangeUrl: need("ADAPTIVE_TOKEN_EXCHANGE_URL"), clientId: need("ADAPTIVE_CLIENT_ID"),
  clientSecret: need("ADAPTIVE_CLIENT_SECRET"), refreshToken: need("ADAPTIVE_REFRESH_TOKEN"),
  version: process.env.ADAPTIVE_VERSION ?? "default",
  ...(process.env.ADAPTIVE_INSTANCE_CODE ? { instanceCode: process.env.ADAPTIVE_INSTANCE_CODE } : {}),
  level: "", sheetName: "EUPTD - Employee Demographics", importKey: "EmpID_EUPTD",
});

const token = await client.authenticate();
const xmlAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// From workday_sheets/EUPTD_Demographics_data.xml — a member that EXISTS, with its real internal
// level code and its current value. Writing the same number back is a no-op by value.
const LEVEL = "SUPERVISORY_Workforce_Planning_Department";
const EMPID = "EMP_0019";
const METRIC = process.env.PROBE_METRIC ?? "PY Pay";
const MONTH = "01/2026";
const VALUE = process.env.PROBE_VALUE ?? "27.0";   // EMP_0019 current PY Pay — writing it back is a no-op by value

// The MINIMAL row: Level|EmpID|metric|month. adaptive_modeled_import_minimal_row defaults to true
// in the working agent, and its comment says why — the export carries placeholder Job_Group and
// Job_Classification values, so sending those columns asks Adaptive to match members that are not
// real. Omitting them is the difference between 6 dimension errors and a write.
const header = `Level|EmpID_EUPTD|${METRIC}|${MONTH}`;
const row = `${LEVEL}|${EMPID}|${VALUE}|`;

const xml = [
  `<?xml version='1.0' encoding='UTF-8'?>`,
  `<call method="importConfigurableModelData" callerName="MoolaiHrisLoader-Probe">`,
  `  <credentials token="${xmlAttr(token)}" instanceCode="${xmlAttr(process.env.ADAPTIVE_INSTANCE_CODE ?? "")}"/>`,
  `  <importDataOptions planOrActuals="Plan" allowParallel="false" moveBPtr="false"`,
  `                     useMappings="false" replaceExisting="3" importKey="EmpID_EUPTD"/>`,
  `  <version name="${xmlAttr(process.env.ADAPTIVE_VERSION ?? "")}" isDefault="false"/>`,
  `  <sheet name="EUPTD - Employee Demographics" isUserAssigned="false"/>`,
  `  <rowData>`,
  `    <header>${header}</header>`,
  `    <rows>`,
  `    <row>${row}</row>`,
  `    </rows>`,
  `  </rowData>`,
  `</call>`,
].join("\n");

console.log("=== REQUEST (minimal row, real level code, existing EmpID) ===");
console.log(xml.replace(token, "<TOKEN>"));

const r = await fetch(need("ADAPTIVE_API_URL"), {
  method: "POST", headers: { "Content-Type": "application/xml" }, body: xml,
});
const text = await r.text();
console.log(`\n=== RESPONSE HTTP ${r.status} ===`);
console.log(text.slice(0, 1800));
console.log(`\n=== VERDICT: ${/success="true"/.test(text) ? "WRITE SUCCEEDED" : "still rejected"} ===`);
