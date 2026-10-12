/**
 * UC3 module-owned activities — build Vetty/WorkBright/Drive from env, wrap the shared PaylocityConnector.
 * @lifespan PRODUCTION
 * @responsibility Build VettyConnector/WorkBrightConnector/GoogleDriveConnector/PaylocityConnector ONCE from
 *   loadEnv() inside this module's own activities.ts — never injected from the host, never built elsewhere
 *   (demo → simulator baseUrl, live → the real vendor APIs — PLATFORM_MODE is the only live-ness switch).
 *   The Paylocity connector here is the same shared platform/* class (not modified), constructed a second
 *   time from env the same way platform/activities.ts does for the hris port — UC3 finalize is its own
 *   activity, not one of the six reserved shared activities. Activity names fetchBackgroundCheck/fetchI9/
 *   fileDocument/createEmployeeStaging are globally unique.
 *
 *   fileDocument re-hydrates `doc.bytes` defensively: `doc` arrives here as the RETURN VALUE of a prior
 *   activity (fetchBackgroundCheck/fetchI9), so it has already round-tripped through Temporal's default JSON
 *   payload converter — which has no special case for a Uint8Array nested inside a plain object, so it comes
 *   back as `{"0":37,"1":80,...}` rather than a real typed array. Rebuild it before handing it to
 *   GoogleDriveConnector.putFile, whose Buffer.from(bytes) requires an actual Uint8Array/array-like. (Found by
 *   running scripts/demo.ts end-to-end against the real worker — the existing workflow tests only ever
 *   exercise this hop through InMemoryDrive, which never made the same round trip.)
 *
 *   createEmployeeStaging is ledger-idempotent — the same shape as platform/activities.ts's sendEmail
 *   (alreadySent gate before the call, recordSend after) — without it, a Temporal activity retry (the
 *   Paylocity POST actually succeeds but the response is lost) would re-drive a second real Weblink
 *   "Create New Employee" staging call. fileDocument is ledger-idempotent the same way (final audit
 *   finding) — without it, the same class of retry would re-drive a real duplicate Drive upload.
 */
import type { EmployeeRecord, ScreeningDoc } from "../../platform/domain/types.js";
import { loadEnv } from "../../platform/config/env.js";
import { alreadySent, recordSend } from "../../platform/db/sendLedger.js";
import { PaylocityConnector } from "../../platform/connectors/paylocity/paylocityConnector.js";
import { VettyConnector } from "./connectors/vettyConnector.js";
import { WorkBrightConnector } from "./connectors/workBrightConnector.js";
import { GoogleDriveConnector } from "./connectors/driveConnector.js";

const env = loadEnv();
const vetty = new VettyConnector(env.vetty);
const workBright = new WorkBrightConnector(env.workbright);
const drive = new GoogleDriveConnector(env.drive);
const paylocity = new PaylocityConnector(env.paylocity);

export async function fetchBackgroundCheck(screeningId: string): Promise<ScreeningDoc> {
  return vetty.getScreening(screeningId);
}

export async function fetchI9(submissionId: string): Promise<ScreeningDoc> {
  return workBright.getSubmissionFile(submissionId);
}

/** A Uint8Array that has round-tripped through Temporal's default JSON payload converter as a nested object
 *  property deserializes as a plain numeric-keyed object, not a real typed array — rebuild it. Object.values on
 *  a numeric-string-keyed object is guaranteed ascending-numeric order (ES2015+), so this reconstructs the
 *  original byte order exactly. A real Uint8Array (e.g. a direct in-process call) passes through unchanged.
 *  Exported for a direct unit test (test/connectors/personnelFileActivities.test.ts) — everything else in this
 *  file needs a live connector, but this coercion is pure and worth pinning down on its own. */
export function rehydrateBytes(bytes: Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(Object.values(bytes as unknown as Record<string, number>));
}

/** putFile ONLY — no sharing/permission call anywhere in this module (spec §8; DriveConnector has no setPermissions). */
export async function fileDocument(folderId: string, doc: ScreeningDoc): Promise<{ fileId: string }> {
  const idempotencyKey = `personnel-file-doc:${folderId}:${doc.filename}`;
  if (await alreadySent(idempotencyKey)) return { fileId: "skipped" };

  try {
    const result = await drive.putFile(folderId, doc.filename, rehydrateBytes(doc.bytes), doc.contentType);
    await recordSend({ idempotencyKey, to: folderId, template: "personnel-file-doc", status: "sent", messageId: result.fileId });
    return result;
  } catch (e) {
    await recordSend({ idempotencyKey, to: folderId, template: "personnel-file-doc", status: "failed" });
    throw e;
  }
}

export async function createEmployeeStaging(companyId: string, employee: EmployeeRecord): Promise<{ employeeId: string }> {
  const idempotencyKey = `personnel-file-staging:${employee.employeeId}`;
  if (await alreadySent(idempotencyKey)) return { employeeId: "skipped" };

  try {
    const result = await paylocity.createEmployeeStaging({
      companyId,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email,
      birthDate: employee.birthDate,
      hireDate: employee.hireDate,
      costCenter: employee.costCenter,
      phone: employee.phone,
      smsConsent: employee.smsConsent,
    });
    await recordSend({ idempotencyKey, to: employee.employeeId, template: "personnel-file-staging", status: "sent", messageId: result.employeeId });
    return result;
  } catch (e) {
    await recordSend({ idempotencyKey, to: employee.employeeId, template: "personnel-file-staging", status: "failed" });
    throw e;
  }
}
