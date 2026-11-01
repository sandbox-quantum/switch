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

const room = (overrides: Partial<RoomDetail> = {}): RoomDetail => ({
  id: "r1",
  name: "Design",
  description: "Design discussions",
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
  owner_name: "Room owner",
  read_visibility: "private",
  write_visibility: "private",
  created_at: "2026-01-01T00:00:00Z",
  archived: false,
  transport_room_id: "!design:example.test",
  matrix_room_id: "!design:example.test",
  external_channel_id: null,
  instructions: null,
  protection_config: null,
  observe_config: null,
  agent_ids: [],
  agent_statuses: {},
  roles: [],
  join_event_listeners: [],
  archived_at: null,
  ...overrides,
});

function renderRoomPage({
  roomDetails = room(),
  userId = "owner",
  canAdminTenant = false,
}: {
  roomDetails?: RoomDetail;
  userId?: string | null;
  canAdminTenant?: boolean;
} = {}) {
  vi.mocked(useAuth).mockReturnValue({
    user: userId === null ? null : { id: userId },
    canAdminTenant,
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(hooks.useRoom).mockReturnValue({
    data: roomDetails,
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

  return render(<RoomDetailPage />);
}

function accessField() {
  return screen.getByRole("combobox", { name: "Access" });
}

async function selectAccessReadOnly() {
  fireEvent.mouseDown(accessField());
  fireEvent.click(
    await screen.findByRole("option", { name: "Public — read only" }),
  );
}

async function changeAccessToReadOnly() {
  await selectAccessReadOnly();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
  expect(vi.mocked(api.updateRoom).mock.calls[0]?.[1]).toMatchObject({
    read_visibility: "public",
    write_visibility: "private",
  });
}

describe("RoomDetailPage Access editing", () => {
  beforeEach(() => {
    vi.mocked(api.updateRoom).mockResolvedValue(room());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lets the room owner change Access", async () => {
    renderRoomPage({ roomDetails: room({ owner_id: "owner" }) });

    expect(accessField().getAttribute("aria-disabled")).toBeNull();
    await changeAccessToReadOnly();
  });

  it("lets a tenant admin change Access", async () => {
    renderRoomPage({
      roomDetails: room({ owner_id: "someone-else" }),
      userId: "admin",
      canAdminTenant: true,
    });

    expect(accessField().getAttribute("aria-disabled")).toBeNull();
    await changeAccessToReadOnly();
  });

  it("keeps Access disabled for a public-write non-owner while allowing other settings", async () => {
    renderRoomPage({
      roomDetails: room({
        owner_id: "someone-else",
        read_visibility: "public",
        write_visibility: "public",
      }),
      userId: "writer",
    });

    expect(accessField().getAttribute("aria-disabled")).toBe("true");

    const nameField = screen.getByRole("textbox", { name: "Name" });
    expect((nameField as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(nameField, { target: { value: "Updated design" } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    const input = vi.mocked(api.updateRoom).mock.calls[0]?.[1];
    expect(input?.name).toBe("Updated design");
    expect(input).not.toHaveProperty("read_visibility");
    expect(input).not.toHaveProperty("write_visibility");
  });

  it("omits a local Access change after permission is revoked", async () => {
    const roomDetails = room({
      owner_id: "owner",
      write_visibility: "public",
    });
    const rendered = renderRoomPage({ roomDetails });

    await selectAccessReadOnly();

    vi.mocked(useAuth).mockReturnValue({
      user: { id: "writer" },
      canAdminTenant: false,
    } as unknown as ReturnType<typeof useAuth>);
    rendered.rerender(<RoomDetailPage />);

    expect(accessField().getAttribute("aria-disabled")).toBe("true");
    const nameField = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(nameField, { target: { value: "Updated design" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    const input = vi.mocked(api.updateRoom).mock.calls[0]?.[1];
    expect(input?.name).toBe("Updated design");
    expect(input).not.toHaveProperty("read_visibility");
    expect(input).not.toHaveProperty("write_visibility");
  });

  it("keeps an ownerless room's Access admin-only", () => {
    renderRoomPage({
      roomDetails: room({
        owner_id: null,
        read_visibility: "public",
        write_visibility: "public",
      }),
      userId: "member",
    });

    expect(accessField().getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: "Delete room" })).toBeNull();
  });

  it("lets a tenant admin change Access on an ownerless room", async () => {
    renderRoomPage({
      roomDetails: room({ owner_id: null }),
      userId: "admin",
      canAdminTenant: true,
    });

    expect(accessField().getAttribute("aria-disabled")).toBeNull();
    await changeAccessToReadOnly();
  });
});
