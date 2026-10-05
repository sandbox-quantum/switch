import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AttentionBanner from "./AttentionBanner";

describe("AttentionBanner", () => {
  afterEach(() => cleanup());

  it("renders the connection name and the attention message", () => {
    render(
      <AttentionBanner
        displayName="Acme Corp"
        message="Microsoft says Switch is no longer approved in this organisation."
        canApproveAgain={false}
        approving={false}
        onApproveAgain={() => {}}
      />,
    );

    expect(screen.getByText("Acme Corp:")).toBeTruthy();
    expect(
      screen.getByText(
        /Microsoft says Switch is no longer approved in this organisation\./,
      ),
    ).toBeTruthy();
  });

  it("offers to approve again only when that is possible, and calls back on click", () => {
    const onApproveAgain = vi.fn();
    render(
      <AttentionBanner
        displayName="Acme Corp"
        message="Approval was withdrawn."
        canApproveAgain
        approving={false}
        onApproveAgain={onApproveAgain}
      />,
    );

    const button = screen.getByRole("button", { name: "Approve again" });
    fireEvent.click(button);
    expect(onApproveAgain).toHaveBeenCalledTimes(1);
  });

  it("has no action when re-approval is not possible", () => {
    render(
      <AttentionBanner
        displayName="Acme Corp"
        message="Approval was withdrawn."
        canApproveAgain={false}
        approving={false}
        onApproveAgain={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Approve again" })).toBeNull();
  });
});
