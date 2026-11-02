import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDetail } from "../../data/api";
import * as api from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import * as hooks from "../../data/hooks";
import RoomDetailPage from "./RoomDetailPage";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "r1" }),
}));

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useAgents: vi.fn(),
  useBridgeUsers: vi.fn(),
  useRoom: vi.fn(),
  useRoomGroups: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, updateRoom: vi.fn() };
});

vi.mock("./RoomGraphView", () => ({ default: () => null }));
vi.mock("./RoomLinkedRoomsSection", () => ({ default: () => null }));
vi.mock("./RoomResourcesSection", () => ({ default: () => null }));
vi.mock("./ExportRoomYamlDialog", () => ({ default: () => null }));

// Public read & write is the default for a new room, so any workspace member
// can edit it.
const publicRoom = {
  id: "r1",
  name: "planning",
  description: "Sprint planning",
  channel_type: null,
  admin_mode: false,
  agent_count: 0,
  connected_user_count: 0,
  connected_user_names: [],
  bridge_id: null,
  bridge_display_name: null,
  group_id: null,
  group_name: null,
  owner_id: "owner",
  owner_name: "ada",
  read_visibility: "public",
  write_visibility: "public",
  created_at: "2026-10-01T00:00:00Z",
  archived: false,
  transport_room_id: "!r1:example.test",
  matrix_room_id: "!r1:example.test",
  external_channel_id: null,
  instructions: null,
  protection_config: null,
  observe_config: null,
  agent_ids: [],
  agent_statuses: {},
  roles: [],
  join_event_listeners: [],
  archived_at: null,
} as RoomDetail;

function showRoom(room: RoomDetail) {
  vi.mocked(hooks.useRoom).mockReturnValue({
    data: room,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
}

function signInAs(userId: string, canAdminTenant: boolean) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: userId },
    canAdminTenant,
  } as unknown as ReturnType<typeof useAuth>);
}

function accessSelect() {
  return screen.getByRole("combobox", { name: /^Access/ });
}

function nameField() {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
}

describe("RoomDetailPage access control", () => {
  beforeEach(() => {
    showRoom(publicRoom);
    vi.mocked(hooks.useRoomGroups).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useBridgeUsers).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(api.updateRoom).mockResolvedValue(publicRoom);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lets a member edit a publicly writable room but not its access", async () => {
    signInAs("member", false);
    render(<RoomDetailPage />);

    expect(accessSelect().getAttribute("aria-disabled")).toBe("true");
    expect(accessSelect().getAttribute("aria-describedby")).toBeTruthy();
    const hint = document.getElementById(accessSelect().getAttribute("aria-describedby")!);
    expect(hint?.textContent).toContain("Only its owner and admins can change its access.");
    expect(screen.queryByRole("button", { name: "Delete room" })).toBeNull();

    fireEvent.change(nameField(), { target: { value: "retro" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalledTimes(1));
    const [, sent] = vi.mocked(api.updateRoom).mock.calls[0];
    expect(sent.name).toBe("retro");
    expect(sent).not.toHaveProperty("read_visibility");
    expect(sent).not.toHaveProperty("write_visibility");
  });

  it("lets the owner change access", async () => {
    signInAs("owner", false);
    render(<RoomDetailPage />);

    expect(accessSelect().getAttribute("aria-disabled")).toBeNull();
    screen.getByRole("button", { name: "Delete room" });

    fireEvent.mouseDown(accessSelect());
    fireEvent.click(await screen.findByRole("option", { name: "Private (only me)" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateRoom).mock.calls[0][1]).toMatchObject({
      read_visibility: "private",
      write_visibility: "private",
    });
  });

  it("lets a tenant admin who does not own the room change access", () => {
    signInAs("admin", true);
    render(<RoomDetailPage />);

    expect(accessSelect().getAttribute("aria-disabled")).toBeNull();
    screen.getByRole("button", { name: "Delete room" });
  });

  it("leaves a member with no write access nothing to edit", () => {
    showRoom({ ...publicRoom, write_visibility: "private" });
    signInAs("member", false);
    render(<RoomDetailPage />);

    expect(accessSelect().getAttribute("aria-disabled")).toBe("true");
    expect(nameField().disabled).toBe(true);
    screen.getByText(/You don't have write access to this room/);
  });
});
