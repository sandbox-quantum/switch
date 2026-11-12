import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as hooks from "../../data/hooks";
import DeleteResourceDialog from "./DeleteResourceDialog";

vi.mock("../../data/hooks", () => ({
  useDocumentRooms: vi.fn(),
  usePackageRooms: vi.fn(),
  useReferenceRooms: vi.fn(),
}));

function returns<T>(data: T) {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

describe("DeleteResourceDialog", () => {
  beforeEach(() => {
    vi.mocked(hooks.useDocumentRooms).mockReturnValue(
      returns([{ room_id: "r1", room_name: "planning", can_unlink: true }]),
    );
    vi.mocked(hooks.useReferenceRooms).mockReturnValue(returns(null));
    vi.mocked(hooks.usePackageRooms).mockReturnValue(returns(null));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("counts every room the delete removes it from, private ones unnamed", () => {
    render(
      <DeleteResourceDialog
        open
        kind="document"
        resourceId="d1"
        resourceLabel="Spec"
        hiddenRoomsCount={2}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    screen.getByText(/This will detach from 3 rooms/);
    screen.getByText("planning");
    screen.getByText("2 private rooms you can't open");
  });
});
