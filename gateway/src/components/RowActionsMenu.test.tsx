import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RowActionsMenu from "./RowActionsMenu";

describe("RowActionsMenu", () => {
  afterEach(() => cleanup());

  const open = () => fireEvent.click(screen.getByRole("button", { name: "Actions for Dana" }));

  it("runs an available action and closes", () => {
    const rename = vi.fn();
    render(<RowActionsMenu label="Actions for Dana" actions={[{ label: "Rename", onClick: rename }]} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("keeps a disabled action reachable, says why, and does not run it", () => {
    const remove = vi.fn();
    render(
      <RowActionsMenu
        label="Actions for Dana"
        actions={[
          {
            label: "Remove from workspace",
            onClick: remove,
            destructive: true,
            disabledReason: "Dana is the last workspace admin.",
          },
        ]}
      />,
    );
    open();
    const item = screen.getByRole("menuitem", { name: /Remove from workspace/ });
    fireEvent.click(item);

    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("Dana is the last workspace admin.");
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps its clicks from reaching the row", () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <RowActionsMenu label="Actions for Dana" actions={[{ label: "Rename", onClick: () => {} }]} />
      </div>,
    );
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(rowClick).not.toHaveBeenCalled();
  });
});
