/**
 * UC6 packet-library generator — emit the canonical library to a committed fixture.
 * @lifespan THROWAWAY — dev-only; run `npm run gen:packets` whenever the decision table changes.
 * @responsibility Serialize ALL_PACKETS to fixtures/packets/index.json (a deep-equal-checked mirror of the code).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_PACKETS } from "../src/usecases/packetSelection/decisionTable.js";

const dir = fileURLToPath(new URL("../fixtures/packets/", import.meta.url));
const out = fileURLToPath(new URL("../fixtures/packets/index.json", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(out, JSON.stringify(ALL_PACKETS, null, 2) + "\n");
console.log(`wrote ${ALL_PACKETS.length} packets -> ${out}`);
