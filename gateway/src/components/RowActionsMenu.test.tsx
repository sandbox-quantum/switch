import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RowActionsMenu from "./RowActionsMenu";

describe("RowActionsMenu", () => {
  afterEach(() => cleanup());

  const open = () => fireEvent.click(screen.getByRole("button", { name: "Actions for Dana" }));

  it("runs an available action and closes", () => {
    const rename = vi.fn();
    render(<RowActionsMenu tabIndex={0} label="Actions for Dana" actions={[{ label: "Rename", onClick: rename }]} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("keeps a disabled action reachable, says why, and does not run it", () => {
    const remove = vi.fn();
    render(
      <RowActionsMenu
        tabIndex={0}
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

  it("lets the arrow keys reach a disabled action, so its reason can be read", () => {
    render(
      <RowActionsMenu
        tabIndex={0}
        label="Actions for Dana"
        actions={[
          { label: "Rename", onClick: () => {} },
          { label: "Make admin", onClick: () => {}, disabledReason: "Dana is already a workspace admin." },
        ]}
      />,
    );
    open();
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    rename.focus();
    fireEvent.keyDown(rename, { key: "ArrowDown" });

    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Make admin/ }));
  });

  it("takes the server's reason as it comes, leaving an action with a null reason available", () => {
    const transfer = vi.fn();
    const blocked: string | null = "Revoke its service grants before handing it over.";
    const clear: string | null = null;
    render(
      <RowActionsMenu
        tabIndex={0}
        label="Actions for Dana"
        actions={[
          { label: "Transfer", onClick: transfer, disabledReason: clear },
          { label: "Delete", onClick: () => {}, destructive: true, disabledReason: blocked },
        ]}
      />,
    );
    open();
    const deleteItem = screen.getByRole("menuitem", { name: /Delete/ });
    fireEvent.click(screen.getByRole("menuitem", { name: "Transfer" }));

    expect(deleteItem.getAttribute("aria-disabled")).toBe("true");
    expect(deleteItem.textContent).toContain(blocked);
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("has no button when every action is hidden", () => {
    render(<RowActionsMenu tabIndex={0} label="Actions for Dana" actions={[]} />);

    expect(screen.queryByRole("button", { name: "Actions for Dana" })).toBeNull();
  });

  it("follows its cell's tab stop, so a table stays one Tab stop", () => {
    render(<RowActionsMenu tabIndex={-1} label="Actions for Dana" actions={[{ label: "Rename", onClick: () => {} }]} />);

    expect(screen.getByRole("button", { name: "Actions for Dana" }).getAttribute("tabindex")).toBe("-1");
  });

  it("keeps its clicks from reaching the row", () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <RowActionsMenu tabIndex={0} label="Actions for Dana" actions={[{ label: "Rename", onClick: () => {} }]} />
      </div>,
    );
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(rowClick).not.toHaveBeenCalled();
  });
});
