/**
 * Throwaway sample workflow — proves the host wires an arbitrary module's workflow + activity generically.
 * @lifespan THROWAWAY — a host-spine test fixture only; not a real use case.
 */
import { proxyActivities } from "@temporalio/workflow";
const { sampleActivity } = proxyActivities<{ sampleActivity(): Promise<string> }>({ startToCloseTimeout: "10 seconds" });
export async function sampleWorkflow(): Promise<string> {
  return sampleActivity();
}
