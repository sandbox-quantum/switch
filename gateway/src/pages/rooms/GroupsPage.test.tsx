import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomGroupDetail, RoomSummary } from "../../data/api";
import * as hooks from "../../data/hooks";
import GroupsPage from "./GroupsPage";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useRoomGroups: vi.fn(),
  useRooms: vi.fn(),
}));

function room(id: string, name: string, groupId: string | null, canWrite: boolean) {
  return { id, name, group_id: groupId, group_name: null, can_write: canWrite } as unknown as RoomSummary;
}

describe("GroupsPage", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRoomGroups).mockReturnValue({
      data: [
        { id: "g1", name: "Team", color: "#7EB6FF", parent_group_id: null, room_count: 2 } as unknown as RoomGroupDetail,
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useRooms).mockReturnValue({
      data: [
        room("r1", "planning", "g1", true),
        room("r2", "leadership", "g1", false),
        room("r3", "retro", null, true),
        room("r4", "board", null, false),
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("files and unfiles only rooms the viewer may write to", async () => {
    render(<GroupsPage />);
    fireEvent.click(screen.getByText("Team"));

    screen.getByRole("button", { name: "Remove planning from group" });
    expect(screen.queryByRole("button", { name: "Remove leadership from group" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add rooms" }));
    await screen.findByText("retro");
    expect(screen.queryByText("board")).toBeNull();
  });
});
