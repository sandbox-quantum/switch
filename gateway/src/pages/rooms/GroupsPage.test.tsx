import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomGroupDetail } from "../../data/api";
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
    refresh: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
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

function renderAs(isAdmin: boolean) {
  vi.mocked(useAuth).mockReturnValue(authState(isAdmin));
  vi.mocked(hooks.useRoomGroups).mockReturnValue(queryResult([group]));
  vi.mocked(hooks.useRooms).mockReturnValue(queryResult([]));
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
});
