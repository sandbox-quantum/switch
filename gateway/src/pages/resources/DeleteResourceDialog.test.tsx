import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerFetch } from "../../test/answerFetch";
import DeleteResourceDialog from "./DeleteResourceDialog";

const show = (packageCount = 0) => {
  const onDeleted = vi.fn();
  render(
    <DeleteResourceDialog
      kind="document"
      resourceId="d1"
      resourceLabel="Spec"
      hiddenRoomsCount={2}
      packageCount={packageCount}
      onClose={vi.fn()}
      onDeleted={onDeleted}
    />,
  );
  return onDeleted;
};

describe("DeleteResourceDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("counts every room the delete removes it from, private ones unnamed", async () => {
    answerFetch({ "GET /documents/d1/rooms": [200, [{ room_id: "r1", room_name: "planning", can_unlink: true }]] });
    show();

    await screen.findByText(/This will detach it from 3 rooms/);
    screen.getByText("planning");
    screen.getByText("2 private rooms you can't open");
  });

  it("says before deleting which packages it leaves", async () => {
    answerFetch({ "GET /documents/d1/rooms": [200, []] });
    show(2);

    await screen.findByText("It is also taken out of 2 packages.");
  });

  it("holds Delete until it knows the rooms, and says so when they can't be read", async () => {
    answerFetch({ "GET /documents/d1/rooms": [503, { detail: "The database is unavailable." }] });
    show();

    const button = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await screen.findByText(/Couldn't load the rooms it is in, so they aren't listed here: The database/);
    expect(button.disabled).toBe(false);
  });

  it("stays open with the reason when the delete is refused", async () => {
    answerFetch({
      "GET /documents/d1/rooms": [200, []],
      "DELETE /documents/d1": [403, { detail: "Only its owner or an admin can delete it." }],
    });
    const onDeleted = show();

    await waitFor(() => expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await screen.findByText("Only its owner or an admin can delete it.");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
