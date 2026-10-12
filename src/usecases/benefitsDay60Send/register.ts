/**
 * benefitsDay60Send module manifest — started as a detached child by newHireLifecycle (by name string).
 * @lifespan PRODUCTION — plug-in registration; imports only platform/* + this folder.
 */
import type { UseCaseModule } from "../../platform/usecase.js";
import { benefitsDay60Send } from "./workflow.js";
import { stageSend } from "./activities.js";

export const module: UseCaseModule = {
  name: "benefitsDay60Send",
  workflows: { benefitsDay60Send },
  activities: { stageSend } as UseCaseModule["activities"],
  // no trigger of its own — newHireLifecycle starts it as a child by name; Plan 1 puts it in the bundle.
};
