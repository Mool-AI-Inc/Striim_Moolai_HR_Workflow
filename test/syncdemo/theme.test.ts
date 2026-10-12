/**
 * The MoolAI brand tokens exist in two files. This stops them drifting.
 *
 *   src/platform/approval-app/styles.css   the app on :5173 — the source of truth
 *   src/platform/theme/moolai.css          extracted, served to the dashboards on :3000 / :3001
 *
 * The copy exists because styles.css also styles `body` and `.btn` generically, so serving it to
 * the dashboards would fight their own CSS. Copying brand colours is the kind of thing that looks
 * harmless and then quietly leaves two screens a slightly different shade of orange in front of a
 * customer, so the duplication is asserted rather than trusted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Every `--moolai-*: value;` declaration in a stylesheet's first :root block. */
function moolaiTokens(css: string): Record<string, string> {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/(--moolai-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1] as string] = (m[2] as string).replace(/\s+/g, " ").trim();
  }
  return out;
}

const appTokens = moolaiTokens(read("../../src/platform/approval-app/styles.css"));
const themeTokens = moolaiTokens(read("../../src/platform/theme/moolai.css"));

describe("MoolAI theme tokens", () => {
  it("finds tokens in both files at all", () => {
    // A guard on the guard: if a refactor moves or reformats either :root block, the regex could
    // silently match nothing and every comparison below would trivially pass.
    expect(Object.keys(appTokens).length).toBeGreaterThan(20);
    expect(Object.keys(themeTokens).length).toBeGreaterThan(20);
  });

  it("agrees with the approval app on every token they share", () => {
    // Not an equality check in both directions. src/platform/theme/moolai.css is vendored from the
    // design system and is a SUPERSET — it carries the full type scale and the hero gradient, which
    // the approval app's older copy does not. What must never differ is a token they both define:
    // that is how two screens end up a slightly different orange in front of a customer.
    const shared = Object.keys(appTokens).filter((k) => k in themeTokens);
    expect(shared.length).toBeGreaterThan(20);
    const mismatched = shared.filter((k) => appTokens[k] !== themeTokens[k]);
    expect(mismatched, `tokens differ between styles.css and theme/moolai.css: ${mismatched.join(", ")}`)
      .toEqual([]);
  });

  it("carries the full design-system scale the dashboards reach for", () => {
    // The skill is explicit: "No timid type scale. Largest 32px, smallest 14px means you have no
    // scale." These are the rungs above the approval app's copy, so losing them in a re-vendor
    // would quietly flatten the dashboards back to corporate.
    expect(themeTokens["--moolai-text-3xl"]).toBe("56px");
    expect(themeTokens["--moolai-gradient-hero"]).toContain("#EEA53A");
    expect(themeTokens["--moolai-font-product"]).toContain("Poppins");
  });

  it("still carries the values the dashboards are built on", () => {
    // Named explicitly: the dashboard stylesheet derives its surfaces, ink and primary from these
    // four. Renaming one would break both dashboards' palettes, and this says so out loud.
    expect(appTokens["--moolai-cream"]).toBe("#F5F2ED");
    expect(appTokens["--moolai-charcoal"]).toBe("#212121");
    expect(appTokens["--moolai-orange"]).toBe("#E74A0A");
    expect(appTokens["--moolai-radius-card"]).toBe("18px");
  });
});

describe("dashboard stylesheet", () => {
  const dash = read("../../src/syncdemo/ui/app.css");

  it("imports the shared theme rather than restating brand colours", () => {
    expect(dash).toContain('@import url("/moolai.css")');
  });

  it("has no dark-mode block", () => {
    // The MoolAI palette is cream-only and :5173 has no dark variant. A dark block here would
    // invent brand decisions and make the two screens disagree side by side.
    expect(dash).not.toContain("prefers-color-scheme: dark");
  });

  it("uses the brand font and radius tokens", () => {
    expect(dash).toContain("var(--moolai-font-product)");
    expect(dash).toContain("var(--moolai-radius-card)");
    expect(dash).toContain("var(--moolai-radius-pill)");
  });
});
