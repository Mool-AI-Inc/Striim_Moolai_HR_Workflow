/**
 * Unit test for rehydrateBytes — recovers a Uint8Array from Temporal's JSON-round-trip nested-object shape.
 * @lifespan THROWAWAY — unit-tier test only.
 */
import { describe, it, expect } from "vitest";
import { rehydrateBytes } from "../../src/usecases/personnelFile/activities.js";

// Found running scripts/demo.ts end-to-end: fetchBackgroundCheck/fetchI9 return a ScreeningDoc whose `bytes`
// is a real Uint8Array, but by the time fileDocument (a SEPARATE activity) receives it, it has round-tripped
// through Temporal's default JSON payload converter — which serializes a Uint8Array nested inside a plain
// object as `{"0":37,"1":80,...}`, not a JSON array, since only a TOP-LEVEL Uint8Array payload gets the
// binary converter. GoogleDriveConnector.putFile's `Buffer.from(bytes)` then throws
// `ERR_INVALID_ARG_TYPE: Received an instance of Object`. test/workflows/uc3PersonnelFile.test.ts never catches
// this because it wires personnelFile/fakes/inMemoryDrive.ts in place of fileDocument, so real bytes never
// actually cross the wire.
describe("rehydrateBytes — recovers a Uint8Array from Temporal's JSON round trip", () => {
  it("passes a real Uint8Array through unchanged", () => {
    const original = new Uint8Array([37, 80, 68, 70]);
    expect(rehydrateBytes(original)).toBe(original);
  });

  it("rebuilds a Uint8Array from the plain numeric-keyed object shape JSON.parse(JSON.stringify(...)) actually produces", () => {
    const original = new Uint8Array([37, 80, 68, 70, 0, 255]);
    const roundTripped = JSON.parse(JSON.stringify(original)) as unknown as Uint8Array;
    expect(Array.isArray(roundTripped)).toBe(false); // confirms this really is the `{"0":37,...}` shape, not `[37,...]`
    const rebuilt = rehydrateBytes(roundTripped);
    expect(rebuilt).toBeInstanceOf(Uint8Array);
    expect(Array.from(rebuilt)).toEqual(Array.from(original));
  });

  it("preserves byte order past index 9 (a naive string-key sort would put \"10\" before \"2\")", () => {
    const original = new Uint8Array(Array.from({ length: 20 }, (_, i) => i));
    const roundTripped = JSON.parse(JSON.stringify(original)) as unknown as Uint8Array;
    expect(Array.from(rehydrateBytes(roundTripped))).toEqual(Array.from(original));
  });
});
