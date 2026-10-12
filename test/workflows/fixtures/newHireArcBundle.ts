/**
 * Combined workflow bundle for the parent-child test — one worker that knows BOTH the parent and the
 * detached child it starts by name.
 * @lifespan THROWAWAY — a workflow-test fixture only.
 */
export { newHireLifecycle } from "../../../src/usecases/newHireLifecycle/workflow.js";
export { benefitsDay60Send } from "../../../src/usecases/benefitsDay60Send/workflow.js";
