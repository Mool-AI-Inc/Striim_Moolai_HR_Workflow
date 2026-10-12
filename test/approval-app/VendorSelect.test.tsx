/** @lifespan THROWAWAY — ui tier (jsdom + RTL).
 *
 * Replacing a native <select> means taking on everything the browser was doing for free.
 * These pin the parts a keyboard user would notice if they regressed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";   // named export — verbatimModuleSyntax
import { VendorSelect } from "../../src/platform/approval-app/VendorSelect.js";

afterEach(cleanup);   // the `ui` project sets no globals/setup file, so RTL auto-cleanup is NOT registered

const OPTIONS = ["Paylocity", "Workday", "Rippling", "BambooHR"];

function setup(value = "Paylocity") {
  const onChange = vi.fn();
  render(<VendorSelect label="HRIS vendor" value={value} options={OPTIONS} onChange={onChange} />);
  return { onChange, trigger: screen.getByRole("combobox", { name: /HRIS vendor/i }) };
}

describe("VendorSelect (WCAG)", () => {
  it("exposes a labelled combobox that starts closed", () => {
    const { trigger } = setup();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on click and marks the current value as the selected option", async () => {
    const user = userEvent.setup();
    const { trigger } = setup("Workday");
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("option", { name: /Workday/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("option", { name: /Paylocity/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("opens with the keyboard and selects with Enter", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();
    trigger.focus();
    await user.keyboard("{ArrowDown}");          // opens, active = current (Paylocity)
    await user.keyboard("{ArrowDown}");          // -> Workday
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("Workday");
  });

  it("keeps focus on the trigger and tracks the active row with aria-activedescendant", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    trigger.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(trigger);   // focus never moves into the list
    const activeId = trigger.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId as string)?.textContent).toContain("Workday");
  });

  it("supports Home and End", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup("Workday");
    trigger.focus();
    await user.keyboard("{ArrowDown}{End}{Enter}");
    expect(onChange).toHaveBeenCalledWith("BambooHR");
  });

  it("jumps to a vendor by typing its first letters", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("ri");                   // Rippling
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("Rippling");
  });

  it("closes on Escape without changing the value", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();
    trigger.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);   // focus comes back, as a native select does
  });

  it("names the vendor in text, so the mark is never the only carrier of meaning", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    for (const name of OPTIONS) {
      expect(screen.getByRole("option", { name: new RegExp(name) })).toBeTruthy();
    }
  });
});
