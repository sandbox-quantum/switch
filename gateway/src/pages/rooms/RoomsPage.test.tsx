import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GridRowId } from "@mui/x-data-grid";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableColumn } from "../../components/DataTable";
import type { RoomSummary, Session } from "../../data/api";
import * as api from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import { ALL_OFF, GATEWAY_V2 } from "../../data/featureFlags";
import RoomsPage from "./RoomsPage";

// The list offers each room's actions as the server allows them (archive on
// write access, delete on managing it), confirms archive and delete, and in
// the new layout narrows a member's list to the rooms they take part in.

const navigate = vi.fn();
let locationState: unknown = null;
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: "/rooms", state: locationState }),
}));

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const room = (id: string, overrides: Partial<RoomSummary>) =>
  ({
    id,
    name: id,
    description: "",
    channel_type: null,
    admin_mode: false,
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
    viewer_is_member: false,
    can_write: false,
    can_change_members: false,
    can_manage: false,
    can_unlink: false,
    can_transfer: false,
    ...overrides,
  }) as RoomSummary;

const ROOMS = [
  room("mine", {
    owner_id: "u1",
    viewer_is_member: true,
    can_write: true,
    can_manage: true,
    created_at: "2026-10-03T00:00:00Z",
  }),
  room("open", { write_visibility: "public", can_write: true, created_at: "2026-10-02T00:00:00Z" }),
  room("readonly", { created_at: "2026-10-01T00:00:00Z" }),
  room("bridged", {
    bridge_id: "b1",
    bridge_display_name: "Slack",
    viewer_is_member: true,
    can_write: true,
    can_manage: true,
  }),
  room("old", { archived: true, viewer_is_member: true, can_write: true }),
];

vi.mock("../../data/hooks", () => ({
  useRoomGroups: () => ({ data: [], loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return {
    ...actual,
    loadRoomsWithArchived: vi.fn(),
    archiveRoom: vi.fn(),
    unarchiveRoom: vi.fn(),
    bulkArchiveRooms: vi.fn(),
    deleteRoom: vi.fn(),
  };
});

// The data grid lays rows out from measured sizes, which jsdom does not have,
// so it renders none. This draws each row in the order given, its selection
// checkbox when the row is selectable, and its action cell, or the table's
// empty state when there are no rows.
vi.mock("../../components/DataTable", () => ({
  TableEmptyState: ({ title, children }: { title: string; children?: ReactNode }) => (
    <div>
      <p>{title}</p>
      {children}
    </div>
  ),
  default: function FakeTable({
    rows,
    columns,
    emptyState,
    isRowSelectable,
    onRowSelectionModelChange,
  }: {
    rows: RoomSummary[];
    columns: TableColumn<RoomSummary>[];
    emptyState?: ReactNode;
    isRowSelectable?: (row: RoomSummary) => boolean;
    onRowSelectionModelChange?: (ids: GridRowId[]) => void;
  }) {
    const [picked, setPicked] = useState<GridRowId[]>([]);
    const actions = columns.find((c) => c.field === "actions");
    if (rows.length === 0) return <div data-testid="empty">{emptyState}</div>;
    return (
      <div>
        {rows.map((row) => (
          <div key={row.id} data-testid={`row-${row.name}`}>
            {row.name}
            {(isRowSelectable?.(row) ?? true) && (
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
            {actions?.renderCell?.({ row, tabIndex: 0 } as never)}
          </div>
        ))}
      </div>
    );
  },
}));

type Role = "member" | "admin";

function signedInAs(role: Role, layout: "v1" | "v2") {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: role === "admin" ? ("admin" as const) : ("member" as const),
    organization_role: null,
    organization_id: null,
  };
  const session: Session = {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant,
    tenants: [tenant],
    state: "ready",
    can_create_workspace: false,
    can_add_workspace: false,
    invite_email_enabled: false,
  };
  vi.mocked(useAuth).mockReturnValue({
    session,
    capabilities: capabilitiesOf(
      session,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role: tenant.role,
        administers: role === "admin",
        can_delete: false,
        can_manage_data_protection: false,
      },
      { ...ALL_OFF, [GATEWAY_V2]: layout === "v2" },
    ),
  } as unknown as ReturnType<typeof useAuth>);
}

const rowNames = () => screen.queryAllByTestId(/^row-/).map((el) => el.dataset.testid?.slice(4));

async function openMenu(name: string) {
  const row = await screen.findByTestId(`row-${name}`);
  const trigger = within(row).queryByRole("button", { name: `Actions for ${name}` });
  if (trigger) fireEvent.click(trigger);
  return trigger;
}

beforeEach(() => {
  locationState = null;
  signedInAs("admin", "v2");
  vi.mocked(api.loadRoomsWithArchived).mockResolvedValue(ROOMS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoomsPage rows and actions", () => {
  it("lists active rooms newest first, with archived ones on their own tab", async () => {
    render(<RoomsPage />);
    await screen.findByTestId("row-mine");
    expect(rowNames()).toEqual(["mine", "open", "readonly", "bridged"]);
    expect(screen.getByRole("tab", { name: "Active 4" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Archived 1" }));
    expect(rowNames()).toEqual(["old"]);
  });

  it("offers archive on rooms the viewer may write, delete on rooms they manage", async () => {
    render(<RoomsPage />);

    await openMenu("mine");
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await openMenu("open");
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // Nothing to offer: no "…" at all, and nothing to tick.
    expect(await openMenu("readonly")).toBeNull();
    expect(within(screen.getByTestId("row-readonly")).queryByRole("checkbox")).toBeNull();
  });

  it("archives a room once confirmed", async () => {
    vi.mocked(api.archiveRoom).mockResolvedValue({} as never);
    render(<RoomsPage />);
    await openMenu("open");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    const dialog = await screen.findByRole("dialog", { name: "Archive open?" });
    expect(api.archiveRoom).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive room" }));

    await waitFor(() => expect(api.archiveRoom).toHaveBeenCalledWith("open"));
    await waitFor(() => expect(api.loadRoomsWithArchived).toHaveBeenCalledTimes(2));
  });

  it("keeps the dialog open with the server's reason when archiving fails", async () => {
    vi.mocked(api.archiveRoom).mockRejectedValue(new Error("Not authorized"));
    render(<RoomsPage />);
    await openMenu("open");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive open?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive room" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Not authorized");
  });

  it("deletes a room once confirmed, keeping its platform channel and saying so", async () => {
    vi.mocked(api.deleteRoom).mockResolvedValue({ ok: true, channel: null });
    render(<RoomsPage />);
    await openMenu("bridged");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete bridged?" });
    expect(dialog.textContent).toContain("Its Slack channel is kept");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete room" }));

    await waitFor(() => expect(api.deleteRoom).toHaveBeenCalledWith("bridged", false));
  });

  it("unarchives without asking, and says when it fails", async () => {
    vi.mocked(api.unarchiveRoom).mockRejectedValue(new Error("Room not found"));
    render(<RoomsPage />);
    await screen.findByTestId("row-mine");
    fireEvent.click(screen.getByRole("tab", { name: "Archived 1" }));
    await openMenu("old");
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));

    await waitFor(() => expect(api.unarchiveRoom).toHaveBeenCalledWith("old"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't unarchive the room: Room not found",
    );
  });

  it("says when a bulk archive changed only some rooms", async () => {
    vi.mocked(api.bulkArchiveRooms).mockResolvedValue({ updated: 1 });
    render(<RoomsPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "select mine" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "select open" }));

    fireEvent.click(screen.getByRole("button", { name: "Archive (2)" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive 2 rooms?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive rooms" }));

    await waitFor(() => expect(api.bulkArchiveRooms).toHaveBeenCalledWith(["mine", "open"], true));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Archived 1 of 2; 1 you can't change or no longer exist.",
    );
  });

  it("clears an earlier notice once a later action succeeds", async () => {
    vi.mocked(api.bulkArchiveRooms).mockResolvedValue({ updated: 1 });
    vi.mocked(api.archiveRoom).mockResolvedValue({} as never);
    render(<RoomsPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "select mine" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "select open" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive (2)" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Archive 2 rooms?" })).getByRole("button", {
        name: "Archive rooms",
      }),
    );
    await screen.findByText(/Archived 1 of 2/);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await openMenu("bridged");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Archive bridged?" })).getByRole("button", {
        name: "Archive room",
      }),
    );
    await waitFor(() => expect(api.archiveRoom).toHaveBeenCalledWith("bridged"));
    await waitFor(() => expect(screen.queryByText(/Archived 1 of 2/)).toBeNull());
  });

  it("reads the rooms again when the viewer's role changes while the page is open", async () => {
    const { rerender } = render(<RoomsPage />);
    await screen.findByTestId("row-mine");
    expect(api.loadRoomsWithArchived).toHaveBeenCalledTimes(1);

    signedInAs("member", "v2");
    rerender(<RoomsPage />);
    await waitFor(() => expect(api.loadRoomsWithArchived).toHaveBeenCalledTimes(2));
  });

  it("shows a notice another page left, such as a channel left to clean up", async () => {
    locationState = { notice: "The room was deleted, but its Slack channel could not be archived." };
    render(<RoomsPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be archived");
  });

  it("says why the rooms could not be loaded, rather than showing an empty list", async () => {
    vi.mocked(api.loadRoomsWithArchived).mockRejectedValue(new Error("Service unavailable"));
    render(<RoomsPage />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't load the rooms: Service unavailable",
    );
    expect(screen.queryByTestId("empty")).toBeNull();
  });
});

describe("RoomsPage scope", () => {
  it("shows a member only their own rooms in the new layout", async () => {
    signedInAs("member", "v2");
    render(<RoomsPage />);
    await screen.findByTestId("row-mine");
    expect(rowNames()).toEqual(["mine", "bridged"]);
    expect(screen.getByText("Rooms in Acme that you own, are in, or have an agent in.")).toBeTruthy();
  });

  it("shows an admin every room", async () => {
    render(<RoomsPage />);
    await screen.findByTestId("row-mine");
    expect(rowNames()).toEqual(["mine", "open", "readonly", "bridged"]);
    expect(screen.getByText("Rooms in Acme.")).toBeTruthy();
  });

  it("keeps showing a member every room they may read in today's layout", async () => {
    signedInAs("member", "v1");
    render(<RoomsPage />);
    await screen.findByTestId("row-mine");
    expect(rowNames()).toEqual(["mine", "open", "readonly", "bridged"]);
  });

  it("words an empty list for an admin and for a member", async () => {
    vi.mocked(api.loadRoomsWithArchived).mockResolvedValue([]);
    render(<RoomsPage />);
    expect(await screen.findByText("No rooms in Acme yet")).toBeTruthy();
    cleanup();

    signedInAs("member", "v2");
    render(<RoomsPage />);
    expect(await screen.findByText("You're not in any rooms in Acme yet")).toBeTruthy();
    expect(within(screen.getByTestId("empty")).getByRole("button", { name: "New room" })).toBeTruthy();
  });

  it("says when there are no archived rooms", async () => {
    vi.mocked(api.loadRoomsWithArchived).mockResolvedValue([ROOMS[0]]);
    render(<RoomsPage />);
    await screen.findByTestId("row-mine");
    fireEvent.click(screen.getByRole("tab", { name: "Archived 0" }));
    expect(screen.getByText("No archived rooms")).toBeTruthy();
  });
});
