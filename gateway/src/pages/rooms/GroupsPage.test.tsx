import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomGroupDetail, RoomSummary } from "../../data/api";
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
  useRooms: vi.fn(),
}));

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
  vi.mocked(hooks.useRooms).mockReturnValue(queryResult(rooms));
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
    screen.getByRole("button", { name: "Remove planning from group" });
    expect(screen.queryByRole("button", { name: "Remove leadership from group" })).toBeNull();
    expect(screen.queryByRole("button", { name: /add rooms/i })).toBeNull();
    cleanup();

    renderAs(true, rooms);
    fireEvent.click(screen.getByText("Customers"));
    fireEvent.click(screen.getByRole("button", { name: "Add rooms" }));
    await screen.findByText("retro");
    expect(screen.queryByText("board")).toBeNull();
  });
});
