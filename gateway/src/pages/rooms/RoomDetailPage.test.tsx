import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDetail } from "../../data/api";
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

vi.mock("./RoomGraphView", () => ({ default: () => null }));
vi.mock("./RoomLinkedRoomsSection", () => ({ default: () => null }));
vi.mock("./RoomResourcesSection", () => ({ default: () => null }));
vi.mock("./ExportRoomYamlDialog", () => ({ default: () => null }));

const ACCESS_HINT = "Only the room's owner or an admin can change access.";

// Public read & write is the default for a new room, so any workspace member
// can edit it.
const room = {
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

function signInAs(userId: string, canAdminTenant: boolean) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: userId },
    canAdminTenant,
  } as unknown as ReturnType<typeof useAuth>);
}

function accessSelect() {
  return screen.getByRole("combobox", { name: /^Access/ });
}

describe("RoomDetailPage access control", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRoom).mockReturnValue({
      data: room,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
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
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not let a member who is neither owner nor admin change access", () => {
    signInAs("member", false);
    render(<RoomDetailPage />);

    expect(accessSelect().getAttribute("aria-disabled")).toBe("true");
    screen.getByText(ACCESS_HINT);
    // The room is publicly writable, so the rest of its settings stay editable.
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).disabled).toBe(false);
  });

  it("lets the owner change access", () => {
    signInAs("owner", false);
    render(<RoomDetailPage />);

    expect(accessSelect().getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(ACCESS_HINT)).toBeNull();
  });

  it("lets a tenant admin who does not own the room change access", () => {
    signInAs("admin", true);
    render(<RoomDetailPage />);

    expect(accessSelect().getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(ACCESS_HINT)).toBeNull();
  });
});
