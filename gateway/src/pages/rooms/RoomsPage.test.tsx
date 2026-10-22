import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GridColDef, GridRowId, GridRowParams } from "@mui/x-data-grid";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSummary } from "../../data/api";
import * as api from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import RoomsPage from "./RoomsPage";

// Archiving a room is a write: its owner, an admin, or anyone in a publicly
// writable room. The page offers it only there, and says when the server
// changed fewer rooms than were asked for.

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(),
}));

const room = (id: string, overrides: Partial<RoomSummary>) =>
  ({
    id,
    name: id,
    description: "",
    channel_type: null,
    agent_count: 0,
    connected_user_count: 0,
    connected_user_names: [],
    bridge_id: null,
    bridge_display_name: null,
    group_id: null,
    group_name: null,
    owner_id: "someone",
    owner_name: "someone",
    read_visibility: "public",
    write_visibility: "private",
    created_at: "2026-10-01T00:00:00Z",
    archived: false,
    ...overrides,
  }) as RoomSummary;

const ROOMS = [
  room("mine", { owner_id: "u1" }),
  room("open", { write_visibility: "public" }),
  room("readonly", {}),
];

vi.mock("../../data/hooks", () => ({
  useRooms: () => ({ data: ROOMS, loading: false, error: null, refetch: vi.fn() }),
  useRoomGroups: () => ({ data: [], loading: false, error: null, refetch: vi.fn() }),
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

// The data grid lays rows out from measured sizes, which jsdom does not have,
// so it renders none. This draws each row, its selection checkbox when the
// row is selectable, and its action cell plainly.
vi.mock("../../components/DataTable", () => ({
  default: function FakeTable({
    rows,
    columns,
    isRowSelectable,
    onRowSelectionModelChange,
  }: {
    rows: RoomSummary[];
    columns: GridColDef<RoomSummary>[];
    isRowSelectable?: (p: GridRowParams<RoomSummary>) => boolean;
    onRowSelectionModelChange?: (ids: GridRowId[]) => void;
  }) {
    const [picked, setPicked] = useState<GridRowId[]>([]);
    const actions = columns.find((c) => c.field === "actions");
    return (
      <div>
        {rows.map((row) => (
          <div key={row.id} data-testid={`row-${row.name}`}>
            {row.name}
            {(isRowSelectable?.({ row } as GridRowParams<RoomSummary>) ?? true) && (
              <input
                type="checkbox"
                aria-label={`select ${row.name}`}
                onChange={() => {
                  const next = [...picked, row.id];
                  setPicked(next);
                  onRowSelectionModelChange?.(next);
                }}
              />
            )}
            {actions?.renderCell?.({ row } as never)}
          </div>
        ))}
      </div>
    );
  },
}));

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1" },
    canAdminTenant: false,
  } as unknown as ReturnType<typeof useAuth>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoomsPage archive", () => {
  it("offers archive only on rooms the user can write", () => {
    render(<RoomsPage />);

    for (const name of ["mine", "open"]) {
      const row = screen.getByTestId(`row-${name}`);
      expect(within(row).getByRole("button", { name: "Archive" })).toBeTruthy();
      expect(within(row).getByRole("checkbox")).toBeTruthy();
    }
    const readonly = screen.getByTestId("row-readonly");
    expect(within(readonly).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(within(readonly).queryByRole("checkbox")).toBeNull();
  });

  it("offers archive on every room to an admin", () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u1" },
      canAdminTenant: true,
    } as unknown as ReturnType<typeof useAuth>);
    render(<RoomsPage />);

    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(3);
  });

  it("says when a bulk archive changed only some rooms", async () => {
    vi.mocked(api.bulkArchiveRooms).mockResolvedValue({ updated: 1 });
    render(<RoomsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "select mine" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "select open" }));

    fireEvent.click(screen.getByRole("button", { name: "Archive (2)" }));

    await waitFor(() =>
      expect(api.bulkArchiveRooms).toHaveBeenCalledWith(["mine", "open"], true),
    );
    expect(
      (await screen.findByRole("alert")).textContent,
    ).toContain("Archived 1 of 2; 1 you can't change or no longer exist.");
  });

  it("says when a bulk archive failed", async () => {
    vi.mocked(api.bulkArchiveRooms).mockResolvedValue(null);
    render(<RoomsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "select mine" }));

    fireEvent.click(screen.getByRole("button", { name: "Archive (1)" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't archive the selected rooms.",
    );
  });

  it("says when archiving one room failed", async () => {
    vi.mocked(api.archiveRoom).mockRejectedValue(new Error("Not authorized"));
    render(<RoomsPage />);

    fireEvent.click(
      within(screen.getByTestId("row-open")).getByRole("button", { name: "Archive" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't archive the room: Not authorized",
    );
  });
});
