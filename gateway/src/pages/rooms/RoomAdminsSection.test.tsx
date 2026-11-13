import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomDetail } from "../../data/api";
import * as api from "../../data/api";
import RoomAdminsSection from "./RoomAdminsSection";

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, addRoomAdmin: vi.fn(), removeRoomAdmin: vi.fn() };
});

const GRACE = {
  user_id: "u-grace",
  name: "Grace Hopper",
  granted_by: "u-owner",
  granted_at: "2026-11-01T00:00:00Z",
};

function show(fields: Partial<RoomDetail>, viewerId = "u-owner") {
  const onChanged = vi.fn();
  const room = {
    id: "r1",
    room_admins: [GRACE],
    room_admin_candidates: [{ user_id: "u-ada", name: "Ada Lovelace" }],
    can_manage_admins: true,
    ...fields,
  } as RoomDetail;
  render(<RoomAdminsSection room={room} viewerId={viewerId} onChanged={onChanged} />);
  return onChanged;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoomAdminsSection", () => {
  it("lets whoever may choose room admins make someone in the room one", async () => {
    vi.mocked(api.addRoomAdmin).mockResolvedValue({} as RoomDetail);
    const onChanged = show({});

    screen.getByText("Grace Hopper");
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Make room admin" });
    expect(add.disabled).toBe(true);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Person in the room" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Ada Lovelace"));
    fireEvent.click(add);

    await waitFor(() => expect(api.addRoomAdmin).toHaveBeenCalledWith("r1", "u-ada"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("lets whoever may choose room admins remove one", async () => {
    vi.mocked(api.removeRoomAdmin).mockResolvedValue({} as RoomDetail);
    const onChanged = show({});

    fireEvent.click(screen.getByRole("button", { name: "Remove Grace Hopper as room admin" }));

    await waitFor(() => expect(api.removeRoomAdmin).toHaveBeenCalledWith("r1", "u-grace"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows the server's reason when it refuses someone", async () => {
    vi.mocked(api.addRoomAdmin).mockRejectedValue(new Error("Only people can be room admins."));
    show({});

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Person in the room" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Ada Lovelace"));
    fireEvent.click(screen.getByRole("button", { name: "Make room admin" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Only people can be room admins.",
    );
  });

  it("says when no one else can be made a room admin", () => {
    show({ room_admin_candidates: [] });

    expect(screen.queryByRole("button", { name: "Make room admin" })).toBeNull();
    screen.getByText(/No one else here can be made a room admin/);
  });

  it("lets a room admin step down, after asking", async () => {
    vi.mocked(api.removeRoomAdmin).mockResolvedValue({} as RoomDetail);
    const onChanged = show({ can_manage_admins: false, room_admin_candidates: [] }, "u-grace");

    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make room admin" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Step down" }));
    expect(api.removeRoomAdmin).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog", { name: "Step down as room admin?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Step down" }));

    await waitFor(() => expect(api.removeRoomAdmin).toHaveBeenCalledWith("r1", "u-grace"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers someone who can't choose room admins nothing to change for others", () => {
    show({ can_manage_admins: false, room_admin_candidates: [] }, "u-someone");

    screen.getByText("Grace Hopper");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/No one else here/)).toBeNull();
  });
});
