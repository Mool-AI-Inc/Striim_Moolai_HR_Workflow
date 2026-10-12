import { describe, it, expect } from "vitest";
describe("toolchain", () => { it("runs strict ESM TS", () => { const x: number = 2; expect(x).toBe(2); }); });
