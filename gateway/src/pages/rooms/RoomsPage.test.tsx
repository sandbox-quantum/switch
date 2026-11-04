import { cleanup, render, screen, within } from "@testing-library/react";
import type { GridColDef } from "@mui/x-data-grid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSummary } from "../../data/api";
import * as hooks from "../../data/hooks";
import RoomsPage from "./RoomsPage";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useRoomGroups: vi.fn(),
  useRooms: vi.fn(),
}));

// The data grid lays rows out from measured sizes, which jsdom does not have,
// so it renders none. This draws each row, its action cell, and whether it
// may be ticked for a bulk action.
vi.mock("../../components/DataTable", () => ({
  default: ({
    rows,
    columns,
    isRowSelectable,
  }: {
    rows: RoomSummary[];
    columns: GridColDef<RoomSummary>[];
    isRowSelectable?: (row: RoomSummary) => boolean;
  }) => {
    const actions = columns.find((c) => c.field === "actions");
    return (
      <div>
        {rows.map((row) => (
          <div
            key={row.id}
            data-testid={`row-${row.name}`}
            data-selectable={String(isRowSelectable ? isRowSelectable(row) : true)}
          >
            {actions?.renderCell?.({ row } as never)}
          </div>
        ))}
      </div>
    );
  },
}));

function room(id: string, name: string, canWrite: boolean) {
  return {
    id,
    name,
    description: "",
    archived: false,
    group_id: null,
    bridge_id: null,
    connected_user_names: [],
    owner_id: "owner",
    read_visibility: "public",
    write_visibility: canWrite ? "public" : "private",
    can_write: canWrite,
  } as unknown as RoomSummary;
}

describe("RoomsPage archiving", () => {
  beforeEach(() => {
    vi.mocked(hooks.useRooms).mockReturnValue({
      data: [room("r1", "planning", true), room("r2", "leadership", false)],
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
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers archiving only rooms the viewer may write to", () => {
    render(<RoomsPage />);

    const writable = screen.getByTestId("row-planning");
    const readOnly = screen.getByTestId("row-leadership");
    within(writable).getByRole("button", { name: "Archive" });
    expect(within(readOnly).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(writable.dataset.selectable).toBe("true");
    expect(readOnly.dataset.selectable).toBe("false");
  });
});
