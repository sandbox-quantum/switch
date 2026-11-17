import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateUserDialog from "./CreateUserDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CreateUserDialog", () => {
  it("says the account starts in no workspace, and that an operator administers none", async () => {
    render(<CreateUserDialog open onClose={() => {}} onCreated={() => {}} />);

    const dialog = await screen.findByRole("dialog", { name: "Add user" });
    expect(within(dialog).getByText(/The account starts in no workspace/)).toBeTruthy();

    fireEvent.mouseDown(within(dialog).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Platform operator" }));
    expect(
      within(dialog).getByText(
        "Runs Switch here. It doesn't make them an admin of any workspace or organization.",
      ),
    ).toBeTruthy();
  });
});
