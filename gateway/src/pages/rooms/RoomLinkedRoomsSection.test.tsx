import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "../../data/hooks";
import RoomLinkedRoomsSection from "./RoomLinkedRoomsSection";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useLinkedRooms: vi.fn(),
  useRooms: vi.fn(),
}));

describe("RoomLinkedRoomsSection", () => {
  beforeEach(() => {
    vi.mocked(hooks.useLinkedRooms).mockReturnValue({
      data: [
        { target_room_id: "r2", target_room_name: "ops", target_room_description: "", label: "support" },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useRooms).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers linking and unlinking to someone who may write to the room", () => {
    render(<RoomLinkedRoomsSection roomId="r1" canWrite />);

    screen.getByRole("button", { name: "Add linked room" });
    screen.getByRole("button", { name: "Remove link to ops" });
  });

  it("lists the links, with nothing to change, to a reader", () => {
    render(<RoomLinkedRoomsSection roomId="r1" canWrite={false} />);

    screen.getByText("ops");
    expect(screen.queryByRole("button", { name: "Add linked room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove link to ops" })).toBeNull();
  });
});
