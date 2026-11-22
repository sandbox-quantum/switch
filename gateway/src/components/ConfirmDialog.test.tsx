import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmDialog from "./ConfirmDialog";

const dialog = (props: Partial<Parameters<typeof ConfirmDialog>[0]>) => (
  <ConfirmDialog
    open
    title="Remove Dana?"
    description="Dana loses access to this workspace."
    confirmLabel="Remove"
    tone="destructive"
    onConfirm={() => {}}
    onClose={() => {}}
    {...props}
  />
);

describe("ConfirmDialog", () => {
  afterEach(() => cleanup());

  it("is named by its title, described by its description, and closes from its own button", () => {
    const onClose = vi.fn();
    render(dialog({ onClose }));
    const box = screen.getByRole("dialog", { name: "Remove Dana?" });

    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(box.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Dana loses access to this workspace.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes once the action succeeds", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn(async () => {});
    render(dialog({ onConfirm, onClose }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open and shows the error when the action fails", async () => {
    const onClose = vi.fn();
    render(
      dialog({
        onClose,
        onConfirm: async () => {
          throw new Error("Dana is the last workspace admin.");
        },
      }),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Dana is the last workspace admin.");
  });

  it("holds Cancel while the action runs", async () => {
    let finish: () => void = () => {};
    render(dialog({ onConfirm: () => new Promise<void>((resolve) => (finish = resolve)) }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
  });
});
