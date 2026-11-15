import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RoomSummary } from "../../data/api";
import * as api from "../../data/api";
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

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, attachLinkedRoom: vi.fn() };
});

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

  it("loads the rooms to link to only when the dialog opens", async () => {
    render(<RoomLinkedRoomsSection roomId="r1" canWrite />);

    expect(hooks.useRooms).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add linked room" }));

    await screen.findByRole("dialog");
    expect(hooks.useRooms).toHaveBeenCalled();
  });

  it("stays open while a link is being saved, so a failure is not lost", async () => {
    vi.mocked(hooks.useRooms).mockReturnValue({
      data: [{ id: "r3", name: "retro", description: "" } as RoomSummary],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(api.attachLinkedRoom).mockReturnValue(new Promise(() => {}));
    render(<RoomLinkedRoomsSection roomId="r1" canWrite />);

    fireEvent.click(screen.getByRole("button", { name: "Add linked room" }));
    fireEvent.click(await screen.findByText("retro"));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "follows" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    screen.getByRole("dialog");
  });

  it("lists the links, with nothing to change, to a reader", () => {
    render(<RoomLinkedRoomsSection roomId="r1" canWrite={false} />);

    screen.getByText("ops");
    expect(screen.queryByRole("button", { name: "Add linked room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove link to ops" })).toBeNull();
  });
});
