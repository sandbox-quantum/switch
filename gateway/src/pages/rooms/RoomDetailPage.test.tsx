import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, RoomDetail } from "../../data/api";
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
vi.mock("./ExportRoomYamlDialog", () => ({ default: () => null }));
// Their own tests cover what they do with it; here, only that they are told.
vi.mock("./RoomLinkedRoomsSection", () => ({
  default: ({ canWrite }: { canWrite: boolean }) => (
    <div data-testid="linked-rooms" data-can-write={String(canWrite)} />
  ),
}));
vi.mock("./RoomResourcesSection", () => ({
  default: ({ canWrite, canUnlink }: { canWrite: boolean; canUnlink: boolean }) => (
    <div
      data-testid="resources"
      data-can-write={String(canWrite)}
      data-can-unlink={String(canUnlink)}
    />
  ),
}));

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
  can_write: true,
  can_manage: true,
  can_unlink: false,
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
        can_manage: false,
        read_visibility: "public",
        write_visibility: "public",
      }),
      userId: "writer",
    });

    expect(accessField().getAttribute("aria-disabled")).toBe("true");

    const nameField = screen.getByRole("textbox", { name: "Name" });
    expect((nameField as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(nameField, { target: { value: "Updated design" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Updated discussions" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
      target: { value: "Keep replies focused" },
    });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    const input = vi.mocked(api.updateRoom).mock.calls[0]?.[1];
    expect(input).toMatchObject({
      name: "Updated design",
      description: "Updated discussions",
      instructions: "Keep replies focused",
    });
    expect(input).not.toHaveProperty("read_visibility");
    expect(input).not.toHaveProperty("write_visibility");
  });

  it("omits a local Access change after permission is revoked", async () => {
    const roomDetails = room({
      owner_id: "owner",
      read_visibility: "public",
      write_visibility: "public",
    });
    const rendered = renderRoomPage({ roomDetails });

    await selectAccessReadOnly();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Updated design" },
    });

    vi.mocked(useAuth).mockReturnValue({
      user: { id: "writer" },
      canAdminTenant: false,
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(hooks.useRoom).mockReturnValue({
      data: { ...roomDetails, can_manage: false },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    rendered.rerender(<RoomDetailPage />);

    expect(accessField().getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value,
    ).toBe("Updated design");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    const input = vi.mocked(api.updateRoom).mock.calls[0]?.[1];
    expect(input?.name).toBe("Updated design");
    expect(input).not.toHaveProperty("read_visibility");
    expect(input).not.toHaveProperty("write_visibility");
  });

  it("does not enable Save for only a stale Access change after revocation", async () => {
    const roomDetails = room();
    const rendered = renderRoomPage({ roomDetails });
    await selectAccessReadOnly();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled,
    ).toBe(false);

    vi.mocked(hooks.useRoom).mockReturnValue({
      data: { ...roomDetails, can_manage: false },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    rendered.rerender(<RoomDetailPage />);

    expect(accessField().getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled,
    ).toBe(true);
    expect(api.updateRoom).not.toHaveBeenCalled();
  });

  it.each([
    ["private", "private", "private"],
    ["read-only", "public", "private"],
    ["public", "public", "public"],
  ] as const)(
    "uses the server's denial and explains disabled Access for a %s room",
    (_label, readVisibility, writeVisibility) => {
      renderRoomPage({
        roomDetails: room({
          can_manage: false,
          read_visibility: readVisibility,
          write_visibility: writeVisibility,
        }),
        canAdminTenant: true,
      });

      expect(accessField().getAttribute("aria-disabled")).toBe("true");
      const describedBy = accessField().getAttribute("aria-describedby");
      expect(document.getElementById(describedBy!)?.textContent).toContain(
        "Only its owner and admins can change its access.",
      );
    },
  );

  it("keeps an ownerless room's Access admin-only", () => {
    renderRoomPage({
      roomDetails: room({
        owner_id: null,
        bridge_id: "b1",
        bridge_display_name: "Slack",
        can_manage: false,
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
      roomDetails: room({
        owner_id: null,
        bridge_id: "b1",
        bridge_display_name: "Slack",
      }),
      userId: "admin",
      canAdminTenant: true,
    });

    expect(accessField().getAttribute("aria-disabled")).toBeNull();
    await changeAccessToReadOnly();
  });
});

const agent = { id: "a1", name: "planner", parent_agent_id: null } as AgentSummary;

function viewAs(can: { can_write: boolean; can_manage: boolean; can_unlink: boolean }) {
  vi.mocked(hooks.useRoom).mockReturnValue({
    data: room({
      name: "planning",
      description: "Sprint planning",
      bridge_id: "b1",
      bridge_display_name: "Slack",
      agent_count: 1,
      agent_ids: ["a1"],
      read_visibility: "public",
      write_visibility: "public",
      ...can,
    }),
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  render(<RoomDetailPage />);
}

function nameField() {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
}

function joinEventsSwitch() {
  return screen.getByRole<HTMLInputElement>("switch", {
    name: "Notify planner when someone joins",
  });
}

describe("RoomDetailPage permissions", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "member" },
      canAdminTenant: false,
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(hooks.useRoomGroups).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: [agent],
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
    vi.mocked(api.updateRoom).mockResolvedValue(room());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lets someone who may write but not manage edit everything but access", async () => {
    viewAs({ can_write: true, can_manage: false, can_unlink: false });

    expect(accessField().getAttribute("aria-disabled")).toBe("true");
    const describedBy = accessField().getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "Only its owner and admins can change its access.",
    );
    expect(screen.queryByRole("button", { name: "Delete room" })).toBeNull();
    screen.getByRole("button", { name: "Add agent" });
    screen.getByRole("button", { name: "Remove planner" });
    screen.getByRole("button", { name: "Add user" });
    expect(joinEventsSwitch().disabled).toBe(false);
    expect(screen.getByTestId("resources").dataset.canWrite).toBe("true");
    expect(screen.getByTestId("linked-rooms").dataset.canWrite).toBe("true");

    fireEvent.change(nameField(), { target: { value: "retro" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalledTimes(1));
    const [, sent] = vi.mocked(api.updateRoom).mock.calls[0];
    expect(sent.name).toBe("retro");
    expect(sent).not.toHaveProperty("read_visibility");
    expect(sent).not.toHaveProperty("write_visibility");
  });

  it("lets someone who may manage the room change its access and delete it", async () => {
    viewAs({ can_write: true, can_manage: true, can_unlink: false });

    expect(accessField().getAttribute("aria-disabled")).toBeNull();
    screen.getByRole("button", { name: "Delete room" });

    fireEvent.mouseDown(accessField());
    fireEvent.click(await screen.findByRole("option", { name: "Private" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateRoom).mock.calls[0][1]).toMatchObject({
      read_visibility: "private",
      write_visibility: "private",
    });
  });

  it("loads the platform's users only when someone adds one", async () => {
    viewAs({ can_write: true, can_manage: false, can_unlink: false });
    expect(hooks.useBridgeUsers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add user" }));

    await screen.findByRole("dialog", { name: "Add users" });
    expect(hooks.useBridgeUsers).toHaveBeenCalledWith("b1");
  });

  it("offers a reader nothing to change", () => {
    viewAs({ can_write: false, can_manage: false, can_unlink: false });

    screen.getByText(/You don't have write access to this room/);
    expect(accessField().getAttribute("aria-disabled")).toBe("true");
    expect(nameField().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Delete room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove planner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add user" })).toBeNull();
    // The setting still shows; it just cannot be changed.
    expect(joinEventsSwitch().disabled).toBe(true);
    expect(screen.getByTestId("resources").dataset.canWrite).toBe("false");
    expect(screen.getByTestId("linked-rooms").dataset.canWrite).toBe("false");
  });

  it("lets someone taking part in a room they cannot edit unlink its resources", () => {
    viewAs({ can_write: false, can_manage: false, can_unlink: true });

    expect(screen.getByTestId("resources").dataset.canWrite).toBe("false");
    expect(screen.getByTestId("resources").dataset.canUnlink).toBe("true");
  });
});
