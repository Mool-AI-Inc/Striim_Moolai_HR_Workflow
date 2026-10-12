// Static re-export of every module workflow — Temporal bundles this physical path.
// Plan-1 integration adds one `export *` per delivered module.
// @lifespan PRODUCTION — the composition root's workflow bundle; whitelisted by the isolation rail.
export * from "../usecases/newHireLifecycle/workflow.js";
export * from "../usecases/packetSelection/workflow.js";
export * from "../usecases/benefitsDay60Send/workflow.js";   // no trigger, but the child-by-name must resolve here
export * from "../usecases/birthdayAnniversaryScan/workflow.js";
export * from "../usecases/startingSoonScan/workflow.js";
export * from "../usecases/monthlyFinanceReport/workflow.js";
export * from "../usecases/personnelFile/workflow.js";
