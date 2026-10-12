/**
 * The plugin boundary — a use case is a UseCaseModule the host wires generically.
 * @lifespan PRODUCTION — the contract every module is written against.
 * @responsibility Declare HostCtx (the injected Client + connectors), the Trigger union, and the module manifest.
 */
import type { Client } from "@temporalio/client";
import type { ConnectorRegistry } from "./connectors/types.js";  // type declared in Task 3; instance built in Task 12
export interface HostCtx { temporal: Client; connectors: ConnectorRegistry; }  // unified Client — exposes .workflow.* (triggers call host.temporal.workflow.start) + .schedule.* (scheduler)
export interface EventPayload { companyId: string; employeeId: string; [k: string]: unknown; }
export type Trigger =
  | { kind: "event";    event: string; start: (payload: EventPayload, host: HostCtx) => Promise<void> }
  | { kind: "schedule"; id: string; cron: string; start: (host: HostCtx) => Promise<void> }
  | { kind: "webhook";  method: "POST"; path: string; handler: (body: unknown, host: HostCtx) => Promise<void> };
export interface UseCaseModule {
  name: string;
  workflows: Record<string, unknown>;
  activities: Record<string, (...a: unknown[]) => Promise<unknown>>;
  triggers?: Trigger[];
}
