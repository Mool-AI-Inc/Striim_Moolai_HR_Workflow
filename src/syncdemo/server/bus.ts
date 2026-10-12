/**
 * In-process publish/subscribe for pushing state changes to connected browsers.
 * @lifespan PRODUCTION — the transport between the pipeline and Server-Sent Events.
 * @responsibility Fan one message out to every open SSE connection. No state of its own.
 *
 * SSE rather than WebSockets on purpose. The traffic here is strictly one-directional — the
 * server narrates, the browser listens — and everything the browser needs to SEND is already a
 * plain POST. SSE gets automatic reconnection from the browser for free, survives proxies that
 * mishandle upgrade headers, and needs no dependency. A WebSocket would add a library and a
 * heartbeat protocol to carry the same payload one way.
 *
 * The bus never holds the authoritative state. Every message is a notification that something
 * changed in Postgres; the payload is a convenience so the UI does not have to re-fetch on each
 * one, and `snapshot` is always available if a client falls behind or reconnects.
 */
import { EventEmitter } from "node:events";
import type { EventRow, Stage, StageStatus } from "./db.js";

export type Message =
  | { type: "event"; event: EventRow }
  | { type: "stage"; employeeId: string; stage: Stage; status: StageStatus; detail?: string }
  | { type: "employee"; employeeId: string }
  | { type: "systems" }
  | { type: "reset" };

class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A browser tab is one listener. Twenty tabs on a projector plus a laptop is normal at a
    // demo, and Node's default limit of 10 would print a spurious leak warning.
    this.emitter.setMaxListeners(0);
  }

  publish(message: Message): void {
    this.emitter.emit("message", message);
  }

  subscribe(fn: (m: Message) => void): () => void {
    this.emitter.on("message", fn);
    return () => this.emitter.off("message", fn);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount("message");
  }
}

export const bus = new Bus();
