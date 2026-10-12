/**
 * MODULES — the ONE place a UC is enabled/disabled. Plan-1 integration appends one line per delivered module.
 * @lifespan PRODUCTION — the composition root's module list; whitelisted by the isolation rail to import usecases/*.
 */
import type { UseCaseModule } from "./usecase.js";
import { module as newHireLifecycle } from "../usecases/newHireLifecycle/register.js";
import { module as packetSelection } from "../usecases/packetSelection/register.js";
import { module as benefitsDay60Send } from "../usecases/benefitsDay60Send/register.js";
// Plan-3 modules export `<name>Module` (not `module`) — alias on import to keep the MODULES line canonical.
import { birthdayAnniversaryScanModule as birthdayAnniversaryScan } from "../usecases/birthdayAnniversaryScan/register.js";
import { startingSoonScanModule as startingSoonScan } from "../usecases/startingSoonScan/register.js";
import { monthlyFinanceReportModule as monthlyFinanceReport } from "../usecases/monthlyFinanceReport/register.js";
import { personnelFileModule as personnelFile } from "../usecases/personnelFile/register.js";

export const MODULES: UseCaseModule[] = [
  newHireLifecycle, packetSelection, benefitsDay60Send,                            // Plan 2
  birthdayAnniversaryScan, startingSoonScan, monthlyFinanceReport, personnelFile,  // Plan 3
];
