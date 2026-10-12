/**
 * In-process pub/sub for the reverse pipeline's SSE stream.
 * @lifespan PRODUCTION — the transport between the pipeline and connected browsers.
 *
 * A local copy rather than an import of the forward pipeline's bus. They run as separate
 * processes on separate ports precisely so one can fail without the other, and a shared module
 * would be a shared failure mode the moment either one's message type changed. The type here is
 * deliberately loose: this bus carries notifications, and the authoritative state is always
 * re-read from Postgres by the client.
 */
import { EventEmitter } from "node:events";

export interface Message { type: string; [key: string]: unknown }

class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open tab. Node's default limit of 10 would print a spurious leak warning
    // with a laptop and a projector both connected.
    this.emitter.setMaxListeners(0);
  }

  publish(message: Message): void { this.emitter.emit("message", message); }

  subscribe(fn: (m: Message) => void): () => void {
    this.emitter.on("message", fn);
    return () => this.emitter.off("message", fn);
  }
}

export const bus = new Bus();
