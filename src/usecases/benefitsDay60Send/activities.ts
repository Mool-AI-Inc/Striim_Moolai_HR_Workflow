/**
 * benefitsDay60Send activities — the UC2b file-drop send.
 * @lifespan PRODUCTION — the send path; the file-drop connector is the robot stand-in.
 * @responsibility Drop the EN send via the connector built from env.
 */
import { loadEnv } from "../../platform/config/env.js";
import { FileDropEnConnector } from "./connectors/fileDropEnConnector.js";

const env = loadEnv();
const en = new FileDropEnConnector({ baseUrl: env.simulatorUrl });

export async function stageSend(_companyId: string, employeeId: string): Promise<{ receiptId: string }> {
  return en.stageSend(employeeId);
}
