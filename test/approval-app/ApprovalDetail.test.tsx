import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";   // named export — works under verbatimModuleSyntax
import { ApprovalDetail } from "../../src/platform/approval-app/ApprovalDetail.js";
import type { PendingApproval } from "../../src/platform/domain/types.js";

afterEach(cleanup);   // the `ui` project sets no globals/setup file, so RTL auto-cleanup is NOT registered — do it explicitly

const packet: PendingApproval = {
  id: "a1", workflowId: "packet:E1", kind: "packet-assignment", title: "Assign packet for E1",
  detail: {
    packetId: "PKT-RFT-CX", rationale: "RFT in CX", confidence: 1, flags: [],
    label: "Regular Full-Time · CX", requiredDocs: ["I-9", "W-4", "direct-deposit"],
    employeeType: "RFT", costCenter: "CC-CX", status: "A",
  },
  createdAt: new Date(0).toISOString(), status: "pending",
};

describe("ApprovalDetail (WCAG)", () => {
  it("renders the packet recommendation and blocks approve until a reason is typed", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDetail approval={packet} onDecide={onDecide} />);
    expect(screen.getByText(/RFT-CX/)).toBeTruthy();
    const approve = screen.getByRole("button", { name: /approve/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/reason/i), "confirmed");
    expect(approve.disabled).toBe(false);
    await userEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith({ approved: true, reason: "confirmed", selectedDocs: ["I-9", "W-4", "direct-deposit"] });
  });

  it("lets the reviewer uncheck a doc so only the chosen subset is sent", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDetail approval={packet} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "W-4" }));   // uncheck W-4
    await userEvent.type(screen.getByLabelText(/reason/i), "subset");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onDecide).toHaveBeenCalledWith({ approved: true, reason: "subset", selectedDocs: ["I-9", "direct-deposit"] });
  });

  it("surfaces a rejected decision in the aria-live region", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("409"));
    render(<ApprovalDetail approval={packet} onDecide={onDecide} />);
    await userEvent.type(screen.getByLabelText(/reason/i), "x");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect((await screen.findByRole("status")).textContent).toMatch(/could not|rejected|error/i);
  });

  it("renders each of the four kinds without throwing", () => {
    for (const kind of ["personnel-file", "finance-report", "packet-assignment", "benefits-send"] as const) {
      render(<ApprovalDetail approval={{ ...packet, kind, detail: {} }} onDecide={vi.fn()} />);
    }
  });
});
