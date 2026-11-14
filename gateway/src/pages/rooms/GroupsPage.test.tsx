import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomGroupDetail, RoomSummary } from "../../data/api";
import * as api from "../../data/api";
import { ALL_OFF } from "../../data/featureFlags";
import { useAuth } from "../../data/AuthContext";
import * as hooks from "../../data/hooks";
import type { UseQueryResult } from "../../data/hooks";
import GroupsPage from "./GroupsPage";

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useRoomGroups: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, loadRooms: vi.fn(), deleteRoomGroup: vi.fn() };
});

function authState(canAdminTenant: boolean) {
  return {
    session: null,
    user: null,
    loading: false,
    loadError: null,
    isOperator: false,
    canAdminTenant,
    capabilities: {
      isOperator: false,
      administersWorkspace: canAdminTenant,
      administersOrganization: false,
      inOrganization: false,
      canDeleteWorkspace: false,
      canManageDataProtection: false,
      features: ALL_OFF,
    },
    staleError: null,
    linkNotice: null,
    dismissLinkNotice: vi.fn(),
    recheck: vi.fn(),
    refresh: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    logoutEverywhere: vi.fn(async () => {}),
    switchTo: vi.fn(async () => {}),
  };
}

function queryResult<T>(data: T | null): UseQueryResult<T> {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

const group: RoomGroupDetail = {
  id: "g1",
  name: "Customers",
  description: null,
  color: null,
  parent_group_id: null,
  room_count: 0,
  created_at: "2026-01-01",
};

function room(id: string, name: string, groupId: string | null, canWrite: boolean) {
  return { id, name, group_id: groupId, group_name: null, can_write: canWrite } as unknown as RoomSummary;
}

function renderAs(isAdmin: boolean, rooms: RoomSummary[] = []) {
  vi.mocked(useAuth).mockReturnValue(authState(isAdmin));
  vi.mocked(hooks.useRoomGroups).mockReturnValue(queryResult([group]));
  vi.mocked(api.loadRooms).mockResolvedValue(rooms);
  render(
    <MemoryRouter>
      <GroupsPage />
    </MemoryRouter>,
  );
}

describe("GroupsPage", () => {
  afterEach(cleanup);

  it("lets an admin create, edit and delete groups", () => {
    renderAs(true);
    expect(screen.getByRole("button", { name: /new group/i })).toBeTruthy();
    expect(screen.getByLabelText("Edit Customers")).toBeTruthy();
    expect(screen.getByLabelText("Delete Customers")).toBeTruthy();
  });

  it("hides group management from anyone else", () => {
    renderAs(false);
    expect(screen.getByText("Customers")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new group/i })).toBeNull();
    expect(screen.queryByLabelText("Edit Customers")).toBeNull();
    expect(screen.queryByLabelText("Delete Customers")).toBeNull();
  });

  it("lets only an admin add rooms, and anyone take out a room they may write to", async () => {
    const rooms = [
      room("r1", "planning", "g1", true),
      room("r2", "leadership", "g1", false),
      room("r3", "retro", null, true),
      room("r4", "board", null, false),
    ];
    renderAs(false, rooms);
    fireEvent.click(screen.getByText("Customers"));
    await screen.findByRole("button", { name: "Remove planning from group" });
    expect(screen.queryByRole("button", { name: "Remove leadership from group" })).toBeNull();
    expect(screen.queryByRole("button", { name: /add rooms/i })).toBeNull();
    cleanup();

    renderAs(true, rooms);
    fireEvent.click(screen.getByText("Customers"));
    await screen.findByRole("button", { name: "Remove planning from group" });
    fireEvent.click(screen.getByRole("button", { name: "Add rooms" }));
    await screen.findByText("retro");
    expect(screen.queryByText("board")).toBeNull();
  });

  it("keeps the delete dialog open with the server's reason when deleting fails", async () => {
    vi.mocked(api.deleteRoomGroup).mockRejectedValue(new Error("Group not found"));
    renderAs(true);
    fireEvent.click(screen.getByLabelText("Delete Customers"));
    const dialog = await screen.findByRole("dialog", { name: "Delete Customers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));

    await waitFor(() => expect(api.deleteRoomGroup).toHaveBeenCalledWith("g1"));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Group not found");
  });

  it("says when the groups could not be loaded, rather than that there are none", () => {
    vi.mocked(useAuth).mockReturnValue(authState(true));
    vi.mocked(hooks.useRoomGroups).mockReturnValue({ ...queryResult(null), error: "Failed to fetch data" });
    vi.mocked(api.loadRooms).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Couldn't load the room groups.")).toBeTruthy();
    expect(screen.queryByText(/No groups yet/)).toBeNull();
  });

  it("says when the rooms could not be loaded", async () => {
    vi.mocked(api.loadRooms).mockRejectedValue(new Error("Service unavailable"));
    vi.mocked(useAuth).mockReturnValue(authState(true));
    vi.mocked(hooks.useRoomGroups).mockReturnValue(queryResult([group]));
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Couldn't load the rooms: Service unavailable")).toBeTruthy();
  });
});
