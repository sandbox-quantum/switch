import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSummary } from "../../data/api";
import * as hooks from "../../data/hooks";
import ResourceAttachmentsSection from "./ResourceAttachmentsSection";

vi.mock("../../data/hooks", () => ({
  useDocumentRooms: vi.fn(),
  usePackageRooms: vi.fn(),
  useReferenceRooms: vi.fn(),
  useRooms: vi.fn(),
}));

function returns<T>(data: T) {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

function room(id: string, name: string, canWrite: boolean) {
  return { id, name, description: "", can_write: canWrite } as RoomSummary;
}

describe("ResourceAttachmentsSection", () => {
  beforeEach(() => {
    vi.mocked(hooks.useDocumentRooms).mockReturnValue(
      returns([
        { room_id: "r1", room_name: "planning", can_unlink: true },
        { room_id: "r2", room_name: "leadership", can_unlink: false },
      ]),
    );
    vi.mocked(hooks.useReferenceRooms).mockReturnValue(returns(null));
    vi.mocked(hooks.usePackageRooms).mockReturnValue(returns(null));
    vi.mocked(hooks.useRooms).mockReturnValue(
      returns([
        room("r1", "planning", true),
        room("r2", "leadership", false),
        room("r3", "retro", true),
        room("r4", "announcements", false),
      ]),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers unlinking only from rooms the viewer takes part in", () => {
    render(<ResourceAttachmentsSection kind="document" resourceId="d1" hiddenRoomsCount={0} />);

    screen.getByText("leadership");
    screen.getByRole("button", { name: "Detach from planning" });
    expect(screen.queryByRole("button", { name: "Detach from leadership" })).toBeNull();
  });

  it("offers attaching only to rooms the viewer may write to, loading them on open", async () => {
    render(<ResourceAttachmentsSection kind="document" resourceId="d1" hiddenRoomsCount={0} />);
    expect(hooks.useRooms).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Attach to room" }));

    await screen.findByText("retro");
    expect(screen.queryByText("announcements")).toBeNull();
    // Already attached, so not offered again.
    expect(screen.getAllByText("planning")).toHaveLength(1);
  });

  it("tells whoever manages it how many rooms it is in that they cannot open", () => {
    render(<ResourceAttachmentsSection kind="document" resourceId="d1" hiddenRoomsCount={2} />);

    screen.getByText("Also in 2 private rooms you can't open.");
  });

  it("does not claim it is in no rooms when every room it is in is private", () => {
    vi.mocked(hooks.useDocumentRooms).mockReturnValue(returns([]));
    render(<ResourceAttachmentsSection kind="document" resourceId="d1" hiddenRoomsCount={1} />);

    screen.getByText("In 1 private room you can't open.");
    expect(screen.queryByText("Not attached to any rooms yet.")).toBeNull();
  });
});
