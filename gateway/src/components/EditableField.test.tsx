import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EditableField from "./EditableField";

const field = (props: Partial<Parameters<typeof EditableField>[0]>) => (
  <EditableField
    label="Workspace name"
    value="Acme"
    canEdit
    readOnlyHelper="An org admin or a workspace admin can change this."
    editLabel="Rename workspace"
    maxLength={255}
    onSave={async () => {}}
    {...props}
  />
);

const box = () => screen.getByLabelText("Workspace name") as HTMLInputElement;
const update = () => screen.getByRole("button", { name: "Update" }) as HTMLButtonElement;

describe("EditableField", () => {
  afterEach(() => cleanup());

  it("shows the value read-only, with a pencil and nothing said about who may change it", () => {
    render(field({}));

    expect(box().value).toBe("Acme");
    expect(box().readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Rename workspace" })).toBeTruthy();
    expect(screen.queryByText("An org admin or a workspace admin can change this.")).toBeNull();
  });

  it("gives someone who may not change it no pencil, and says who can", () => {
    render(field({ canEdit: false }));

    expect(box().value).toBe("Acme");
    expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
    const helper = screen.getByText("An org admin or a workspace admin can change this.");
    expect(box().getAttribute("aria-describedby")).toBe(helper.id);
  });

  it("opens for editing from the pencil, waiting for a change before Update", () => {
    render(field({}));
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));

    expect(box().readOnly).toBe(false);
    expect(box().value).toBe("Acme");
    expect(box().maxLength).toBe(255);
    expect(document.activeElement).toBe(box());
    expect(update().disabled).toBe(true);

    fireEvent.change(box(), { target: { value: "   " } });
    expect(update().disabled, "a blank name").toBe(true);
    fireEvent.change(box(), { target: { value: " Acme " } });
    expect(update().disabled, "the same name, spaced").toBe(true);
    fireEvent.change(box(), { target: { value: "Research" } });
    expect(update().disabled).toBe(false);
  });

  it("updates with the trimmed name, then closes and hands the keyboard back to the pencil", async () => {
    const onSave = vi.fn(async () => {});
    render(field({ onSave }));
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(box(), { target: { value: "  Research  " } });
    await act(async () => fireEvent.click(update()));

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Research");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(box().readOnly).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename workspace" }));
  });

  it("shows the stored value, not what was typed, once it closes", async () => {
    const { rerender } = render(field({}));
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(box(), { target: { value: "Research" } });
    await act(async () => fireEvent.click(update()));
    expect(box().value, "until the stored value changes").toBe("Acme");

    rerender(field({ value: "Research" }));
    expect(box().value).toBe("Research");
  });

  it("updates on Enter and cancels on Escape", async () => {
    const onSave = vi.fn(async () => {});
    render(field({ onSave }));
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(box(), { target: { value: "Research" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Research");

    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(box(), { target: { value: "Discarded" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onSave).toHaveBeenCalledOnce();
    expect(box().value).toBe("Acme");
    expect(box().readOnly).toBe(true);
  });

  it("sends once when Enter and Update come together", async () => {
    const onSave = vi.fn(async () => {});
    render(field({ onSave }));
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(box(), { target: { value: "Research" } });
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
      fireEvent.click(update());
    });

    expect(onSave).toHaveBeenCalledOnce();
  });

  it("does not update on the Enter that ends an input method's composition", () => {
    const onSave = vi.fn(async () => {});
    render(field({ onSave }));
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(box(), { target: { value: "研究" } });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });

    expect(onSave).not.toHaveBeenCalled();
    expect(update()).toBeTruthy();
  });

  it("stays open with what was typed and the reason when the update is refused", async () => {
    render(
      field({
        onSave: async () => {
          throw new Error("Workspace admin access required");
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(box(), { target: { value: "Research" } });
    await act(async () => fireEvent.click(update()));

    expect(box().value).toBe("Research");
    expect(box().readOnly).toBe(false);
    const reason = screen.getByText("Workspace admin access required");
    expect(box().getAttribute("aria-describedby")).toBe(reason.id);
    expect(box().getAttribute("aria-invalid")).toBe("true");
  });
});
