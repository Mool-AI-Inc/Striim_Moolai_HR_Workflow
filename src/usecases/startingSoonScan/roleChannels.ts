/**
 * UC8 role→channel mapping — which Slack channels a new hire lands in on invite.
 * @lifespan PRODUCTION — a small static employeeType/costCenter → channel-id map.
 * @responsibility Every hire gets the company-wide channel, plus their cost-center and employee-type channels.
 */
import type { EmployeeRecord } from "../../platform/domain/types.js";

const GENERAL_CHANNEL = "C-GENERAL";

const COST_CENTER_CHANNELS: Record<string, string> = {
  "CC-RETAIL": "C-RETAIL",
  "CC-OPS": "C-OPS",
  "CC-CX": "C-CX",
  "CC-ENG": "C-ENG",
};

const EMPLOYEE_TYPE_CHANNELS: Record<EmployeeRecord["employeeType"], string> = {
  RFT: "C-FULLTIME",
  RPT: "C-PARTTIME",
  SNL: "C-SEASONAL",
};

export function roleChannels(employee: EmployeeRecord): string[] {
  const channels = [GENERAL_CHANNEL, EMPLOYEE_TYPE_CHANNELS[employee.employeeType]];
  const costCenterChannel = COST_CENTER_CHANNELS[employee.costCenter];
  if (costCenterChannel) channels.push(costCenterChannel);
  return channels;
}
