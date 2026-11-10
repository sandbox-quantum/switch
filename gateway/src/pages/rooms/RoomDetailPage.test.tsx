import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, RoomDetail } from "../../data/api";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomDetailPage from "./RoomDetailPage";

const navigate = vi.fn();
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({ roomId: "r1" }),
}));

vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ canAdminTenant: false }),
}));

vi.mock("../../data/hooks", () => ({
  useAgents: vi.fn(),
  useBridgeUsers: vi.fn(),
  useRoom: vi.fn(),
  useRoomAgentCandidates: vi.fn(),
  useRoomGroups: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return {
    ...actual,
    updateRoom: vi.fn(),
    archiveRoom: vi.fn(),
    deleteRoom: vi.fn(),
    deleteRoomRole: vi.fn(),
  };
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
  default: ({ canAttach, canUnlink }: { canAttach: boolean; canUnlink: boolean }) => (
    <div
      data-testid="resources"
      data-can-attach={String(canAttach)}
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
  channel_on_delete: null,
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
  can_attach: true,
  can_invite_agents: true,
  can_add_people: true,
  can_remove_members: true,
} as RoomDetail;

const agent = { id: "a1", name: "planner", parent_agent_id: null } as AgentSummary;

// Adding to the room and taking members out follow `can_write` unless a
// test sets otherwise; the server decides each of them.
const refetchRoom = vi.fn();

function viewAs(
  can: { can_write: boolean; can_manage: boolean; can_unlink: boolean } & Partial<RoomDetail>,
) {
  vi.mocked(hooks.useRoom).mockReturnValue({
    data: {
      ...room,
      can_attach: can.can_write,
      can_invite_agents: can.can_write,
      can_add_people: can.can_write,
      can_remove_members: can.can_write,
      ...can,
    },
    loading: false,
    error: null,
    refetch: refetchRoom,
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
    vi.mocked(hooks.useRoomAgentCandidates).mockReturnValue({
      data: { agent_ids: null },
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
      "Only its owner and admins can change it;",
    );
    expect(screen.queryByRole("button", { name: "Delete room" })).toBeNull();
    screen.getByRole("button", { name: "Add agent" });
    screen.getByRole("button", { name: "Remove planner" });
    screen.getByRole("button", { name: "Add user" });
    expect(joinEventsSwitch().disabled).toBe(false);
    expect(screen.getByTestId("resources").dataset.canAttach).toBe("true");
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

  it("offers adding an agent to someone in the room who can't change its settings", () => {
    viewAs({ can_write: false, can_manage: false, can_unlink: true, can_invite_agents: true });

    screen.getByRole("button", { name: "Add agent" });
    expect(screen.queryByRole("button", { name: "Remove planner" })).toBeNull();
  });

  it("lists only the agents the viewer may invite in the add-agent picker", async () => {
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: [
        agent,
        { id: "a2", name: "helper", parent_agent_id: null } as AgentSummary,
        { id: "a3", name: "someone-elses", parent_agent_id: null } as AgentSummary,
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useRoomAgentCandidates).mockReturnValue({
      data: { agent_ids: ["a2"] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    viewAs({ can_write: false, can_manage: false, can_unlink: true, can_invite_agents: true });

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));

    expect(await screen.findByText("helper")).toBeTruthy();
    expect(screen.queryByText("someone-elses")).toBeNull();
  });

  it("doesn't offer adding an agent to someone who isn't in the room", () => {
    viewAs({ can_write: true, can_manage: false, can_unlink: false, can_invite_agents: false });

    expect(screen.queryByRole("button", { name: "Add agent" })).toBeNull();
  });

  it("leaves a chat's members to its platform, keeping its settings editable", () => {
    viewAs({
      can_write: true,
      can_manage: false,
      can_unlink: false,
      can_invite_agents: false,
      can_add_people: false,
      can_remove_members: false,
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

    screen.getByText(/Only this room's owner and admins can change these settings/);
    expect(accessSelect().getAttribute("aria-disabled")).toBe("true");
    expect(nameField().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Delete room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove planner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add user" })).toBeNull();
    // The setting still shows; it just cannot be changed.
    expect(joinEventsSwitch().disabled).toBe(true);
    expect(screen.getByTestId("resources").dataset.canAttach).toBe("false");
    expect(screen.getByTestId("linked-rooms").dataset.canWrite).toBe("false");
  });

  it("lists a Switch Console chat's members as its people, to change in Console", () => {
    vi.mocked(hooks.useRoom).mockReturnValue({
      data: {
        ...room,
        bridge_id: null,
        bridge_display_name: null,
        is_console_chat: true,
        connected_user_count: 2,
        connected_user_names: ["Ada Lovelace", "Grace Hopper"],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<RoomDetailPage />);

    expect(screen.getByText("People (2)")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByText(/Connected users/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add user" })).toBeNull();
  });

  it("lists two people who share a name as two people", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(hooks.useRoom).mockReturnValue({
      data: {
        ...room,
        bridge_id: null,
        bridge_display_name: null,
        is_console_chat: true,
        connected_user_count: 2,
        connected_user_names: ["Alex", "Alex"],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<RoomDetailPage />);

    expect(screen.getAllByText("Alex")).toHaveLength(2);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    errors.mockRestore();
  });

  it("lists no people for a room on no app that is not a Console chat", () => {
    vi.mocked(hooks.useRoom).mockReturnValue({
      data: { ...room, bridge_id: null, bridge_display_name: null },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<RoomDetailPage />);

    expect(screen.queryByText(/^People \(/)).toBeNull();
  });

  it("lets someone in the room add to it without changing its settings", () => {
    viewAs({
      can_write: false,
      can_manage: false,
      can_unlink: false,
      can_attach: true,
      can_invite_agents: true,
      can_add_people: true,
      can_remove_members: false,
    });

    expect(nameField().disabled).toBe(true);
    screen.getByRole("button", { name: "Add agent" });
    screen.getByRole("button", { name: "Add user" });
    expect(screen.queryByRole("button", { name: "Remove planner" })).toBeNull();
    expect(screen.getByTestId("resources").dataset.canAttach).toBe("true");
    expect(screen.getByTestId("linked-rooms").dataset.canWrite).toBe("false");
  });

  it("lets someone take out their own agent from a room they don't own", () => {
    vi.mocked(hooks.useAgents).mockReturnValue({
      data: [{ ...agent, can_manage: true }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    viewAs({ can_write: false, can_manage: false, can_unlink: false });

    screen.getByRole("button", { name: "Remove planner" });
  });

  it("lets someone taking part in a room they cannot edit unlink its resources", () => {
    viewAs({ can_write: false, can_manage: false, can_unlink: true });

    expect(screen.getByTestId("resources").dataset.canAttach).toBe("false");
    expect(screen.getByTestId("resources").dataset.canUnlink).toBe("true");
  });
});

describe("RoomDetailPage archive, delete and roles", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRoomGroups).mockReturnValue({ data: [], loading: false, error: null, refetch: vi.fn() });
    vi.mocked(hooks.useAgents).mockReturnValue({ data: [agent], loading: false, error: null, refetch: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("asks before archiving", async () => {
    vi.mocked(api.archiveRoom).mockResolvedValue(room);
    viewAs({ can_write: true, can_manage: false, can_unlink: false });
    fireEvent.click(screen.getByRole("button", { name: "Archive room" }));
    expect(api.archiveRoom).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog", { name: "Archive planning?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive room" }));
    await waitFor(() => expect(api.archiveRoom).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(refetchRoom).toHaveBeenCalled());
  });

  it("keeps the channel unless asked, and archives it when asked", async () => {
    vi.mocked(api.deleteRoom).mockResolvedValue({ ok: true, channel: { outcome: "archived", reason: null } });
    viewAs({ can_write: true, can_manage: true, can_unlink: false, channel_on_delete: "archived" });
    fireEvent.click(screen.getByRole("button", { name: "Delete room" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete planning?" });
    expect(dialog.textContent).toContain("The Slack channel stays as it is; Switch stops syncing it.");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Also archive the Slack channel" }));
    expect(dialog.textContent).toContain("Its Slack channel will be archived.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete room" }));

    await waitFor(() => expect(api.deleteRoom).toHaveBeenCalledWith("r1", true));
    expect(navigate).toHaveBeenCalledWith("/rooms", undefined);
  });

  it("says what is left to clean up when the channel could not be retired", async () => {
    vi.mocked(api.deleteRoom).mockResolvedValue({
      ok: true,
      channel: { outcome: "failed", reason: "missing scope" },
    });
    viewAs({ can_write: true, can_manage: true, can_unlink: false, channel_on_delete: "archived" });
    fireEvent.click(screen.getByRole("button", { name: "Delete room" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete planning?" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Also archive the Slack channel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete room" }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/rooms", {
        state: {
          notice:
            "The room was deleted, but its Slack channel could not be archived (missing scope). Archive it in Slack by hand.",
        },
      }),
    );
  });

  it("offers no choice where the platform keeps the channel, and says so", async () => {
    viewAs({
      can_write: true,
      can_manage: true,
      can_unlink: false,
      bridge_display_name: "Teams",
      channel_on_delete: "kept",
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete room" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete planning?" });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(dialog.textContent).toContain("Its Teams channel stays in Teams; remove it there.");
  });

  it("keeps the delete dialog open with the server's reason when deleting fails", async () => {
    vi.mocked(api.deleteRoom).mockRejectedValue(new Error("Only the owner can delete this room"));
    viewAs({ can_write: true, can_manage: true, can_unlink: false });
    fireEvent.click(screen.getByRole("button", { name: "Delete room" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete planning?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete room" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Only the owner can delete this room",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks before deleting a role, which takes its instructions with it", async () => {
    vi.mocked(api.deleteRoomRole).mockResolvedValue([]);
    viewAs({
      can_write: true,
      can_manage: false,
      can_unlink: false,
      roles: [{ name: "reviewer", instructions: "Review every PR", exclusive: false, held_by: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete role reviewer" }));
    expect(api.deleteRoomRole).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog", { name: "Delete the reviewer role?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete role" }));
    await waitFor(() => expect(api.deleteRoomRole).toHaveBeenCalledWith("r1", "reviewer"));
    await waitFor(() => expect(refetchRoom).toHaveBeenCalled());
  });
});
