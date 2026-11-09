import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, RoomDetail } from "../../data/api";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomDetailPage from "./RoomDetailPage";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ roomId: "r1" }),
}));

vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ canAdminTenant: false }),
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

// Public read & write is the default for a new room, so any workspace member
// can edit it. What the viewer may do comes from the server.
const room = {
  id: "r1",
  name: "planning",
  description: "Sprint planning",
  channel_type: null,
  admin_mode: false,
  agent_count: 1,
  connected_user_count: 0,
  connected_user_names: [],
  bridge_id: "b1",
  bridge_display_name: "Slack",
  group_id: null,
  group_name: null,
  owner_id: "owner",
  owner_name: "ada",
  read_visibility: "public",
  write_visibility: "public",
  created_at: "2026-10-01T00:00:00Z",
  archived: false,
  viewer_is_member: false,
  transport_room_id: "!r1:example.test",
  matrix_room_id: "!r1:example.test",
  external_channel_id: null,
  instructions: null,
  protection_config: null,
  observe_config: null,
  agent_ids: ["a1"],
  agent_statuses: {},
  roles: [],
  join_event_listeners: [],
  archived_at: null,
  can_write: true,
  can_manage: false,
  can_unlink: false,
  can_transfer: false,
  can_change_members: true,
} as RoomDetail;

const agent = { id: "a1", name: "planner", parent_agent_id: null } as AgentSummary;

// Members can be changed by whoever may write to the room, as the server
// says, unless a test sets otherwise.
function viewAs(
  can: { can_write: boolean; can_manage: boolean; can_unlink: boolean } & Partial<RoomDetail>,
) {
  vi.mocked(hooks.useRoom).mockReturnValue({
    data: { ...room, can_change_members: can.can_write, ...can },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  render(<RoomDetailPage />);
}

function accessSelect() {
  return screen.getByRole("combobox", { name: /^Access/ });
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
    vi.mocked(api.updateRoom).mockResolvedValue(room);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lets someone who may write but not manage edit everything but access", async () => {
    viewAs({ can_write: true, can_manage: false, can_unlink: false });

    expect(accessSelect().getAttribute("aria-disabled")).toBe("true");
    const describedBy = accessSelect().getAttribute("aria-describedby");
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

  it("lets someone who may write edit a bridged room's description like any other room's", async () => {
    viewAs({ can_write: true, can_manage: false, can_unlink: false });

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Retro and planning" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRoom).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateRoom).mock.calls[0][1]).toMatchObject({
      description: "Retro and planning",
    });
  });

  it("leaves a chat's members to its platform, keeping its settings editable", () => {
    viewAs({
      can_write: true,
      can_manage: false,
      can_unlink: false,
      can_change_members: false,
      channel_type: "group",
    });

    expect(screen.queryByRole("button", { name: "Add agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove planner" })).toBeNull();
    expect(screen.getByText(/rooms is managed from the messaging platform/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("lets someone who may manage the room change its access and delete it", async () => {
    viewAs({ can_write: true, can_manage: true, can_unlink: false });

    expect(accessSelect().getAttribute("aria-disabled")).toBeNull();
    screen.getByRole("button", { name: "Delete room" });

    fireEvent.mouseDown(accessSelect());
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
    expect(accessSelect().getAttribute("aria-disabled")).toBe("true");
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
