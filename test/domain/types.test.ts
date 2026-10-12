import { describe, it, expect } from "vitest";
import { TEMPLATE } from "../../src/platform/domain/types.js";
describe("templates", () => {
  it("exposes every MVP template alias", () => {
    expect([TEMPLATE.WELCOME, TEMPLATE.DAY60_COMPLIANCE, TEMPLATE.BIRTHDAY, TEMPLATE.ANNIVERSARY, TEMPLATE.WELCOME_SMS, TEMPLATE.UC4_REPORT_READY])
      .toEqual(["welcome", "day60-compliance", "birthday", "anniversary", "welcome-sms", "uc4-report-ready"]);
  });
});
