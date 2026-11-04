import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OperatorActionDialog from "./OperatorActionDialog";
import { REASON_HINT, WORDING, type HostedAction } from "./hostedActions";

function renderDialog(action: HostedAction, onConfirm = vi.fn(), error: string | null = null) {
  render(
    <OperatorActionDialog
      open
      action={action}
      userKeyedId="k1-6d2c91f03ab2"
      boxKeyedId="k1-aaaabbbbcccc"
      busy={false}
      error={error}
      onCancel={() => {}}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

describe("the operator's confirm dialog (W6, p11 and p17)", () => {
  afterEach(cleanup);

  it.each(["pause", "resume", "restart"] as const)(
    "%s says what happens and what they'll see, and needs a reason",
    (action) => {
      const onConfirm = renderDialog(action);
      expect(screen.getByText(WORDING[action].whatHappens)).toBeTruthy();
      expect(screen.getByText(WORDING[action].whatTheySee)).toBeTruthy();
      expect(screen.getByText(REASON_HINT)).toBeTruthy();
      const button = screen.getByRole("button", {
        name: WORDING[action].button,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
      expect(button.disabled).toBe(true);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Ticket 7  " } });
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      expect(onConfirm).toHaveBeenCalledWith("Ticket 7");
    },
  );

  it("keeps a reason with markup as plain text (W.9)", () => {
    const onConfirm = renderDialog("pause");
    const markup = '<img src=x onerror="alert(1)"><b>bold</b>';
    fireEvent.change(screen.getByRole("textbox"), { target: { value: markup } });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause user" }));
    expect(onConfirm).toHaveBeenCalledWith(markup);
  });

  it("shows Resume in the main colour, and Pause and Restart in red", () => {
    for (const [action, colour] of [
      ["resume", "Primary"],
      ["pause", "Error"],
      ["restart", "Error"],
    ] as const) {
      renderDialog(action);
      const button = screen.getByRole("button", { name: WORDING[action].button });
      expect(button.className).toContain(`MuiButton-contained${colour}`);
      cleanup();
    }
  });

  it("caps the reason at 500 characters", () => {
    renderDialog("pause");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
  });

  it("shows a refusal line as an alert", () => {
    renderDialog("restart", vi.fn(), "Hosted agents aren't managed on this server.");
    expect(screen.getByRole("alert").textContent).toBe(
      "Hosted agents aren't managed on this server.",
    );
  });
});
