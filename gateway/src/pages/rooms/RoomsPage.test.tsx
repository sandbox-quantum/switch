import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomSummary } from "../../data/api";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import type { UseQueryResult } from "../../data/hooks";
import RoomsPage from "./RoomsPage";

vi.mock("../../data/hooks", () => ({
  useRooms: vi.fn(),
  useRoomGroups: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return {
    ...actual,
    archiveRoom: vi.fn(),
    unarchiveRoom: vi.fn(),
    bulkArchiveRooms: vi.fn(),
  };
});

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: "r1",
    name: "Design",
    description: "",
    channel_type: "channel",
    admin_mode: false,
    agent_count: 0,
    connected_user_count: 0,
    connected_user_names: [],
    bridge_id: null,
    bridge_display_name: null,
    group_id: null,
    group_name: null,
    owner_id: null,
    owner_name: null,
    read_visibility: "public",
    write_visibility: "public",
    created_at: "2026-01-01T00:00:00Z",
    archived: false,
    ...overrides,
  };
}

function queryResult<T>(data: T | null, refetch = vi.fn()): UseQueryResult<T> {
  return { data, loading: false, error: null, refetch };
}

function setup(rooms: RoomSummary[] = [room()], refetch = vi.fn()) {
  vi.mocked(hooks.useRooms).mockReturnValue(queryResult(rooms, refetch));
  vi.mocked(hooks.useRoomGroups).mockReturnValue(queryResult([]));
  return refetch;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <RoomsPage />
    </MemoryRouter>,
  );
}

describe("RoomsPage archive actions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("says why archiving a room failed instead of doing nothing", async () => {
    setup();
    vi.mocked(api.archiveRoom).mockRejectedValue(
      new Error("You do not have write access to this room."),
    );
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(
      await screen.findByText("You do not have write access to this room."),
    ).toBeTruthy();
  });

  it("says why unarchiving a room failed", async () => {
    setup([room({ archived: true })]);
    vi.mocked(api.unarchiveRoom).mockRejectedValue(
      new Error("That room is no longer archived."),
    );
    renderPage();

    // Archived rooms only appear in the Archived view.
    fireEvent.mouseDown(screen.getByLabelText("Status"));
    fireEvent.click(await screen.findByRole("option", { name: "Archived" }));

    fireEvent.click(await screen.findByRole("button", { name: "Unarchive" }));

    expect(await screen.findByText("That room is no longer archived.")).toBeTruthy();
  });

  it("reloads the rooms after a successful archive and shows no error", async () => {
    const refetch = setup();
    vi.mocked(api.archiveRoom).mockResolvedValue({} as never);
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(api.archiveRoom).toHaveBeenCalledWith("r1"));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the selection when a bulk archive fails", async () => {
    setup();
    vi.mocked(api.bulkArchiveRooms).mockRejectedValue(
      new Error("Some of those rooms may not be archived."),
    );
    renderPage();

    // Select the row, then bulk-archive the selection.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Archive (1)" }),
    );

    expect(
      await screen.findByText("Some of those rooms may not be archived."),
    ).toBeTruthy();
    // Still offering the same selection means the retry targets the same rooms.
    expect(screen.getByRole("button", { name: "Archive (1)" })).toBeTruthy();
  });
});
