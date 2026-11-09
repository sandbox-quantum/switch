import { cleanup, render, waitFor } from "@testing-library/react";
import type { GridColDef } from "@mui/x-data-grid";
import { afterEach, describe, expect, it, vi } from "vitest";
import MembersSection from "./MembersSection";

// The column layout the table is given. With hosted agents v2 off (and for
// anyone but an admin, who never reads the flag) it is main's exactly: the
// designer's wrap and widths are v2's.

const auth = vi.hoisted(() => ({ canAdmin: false }));
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ refresh: async () => {}, canAdminTenant: auth.canAdmin }),
}));
const table = vi.hoisted(() => ({ columns: [] as GridColDef[] }));
vi.mock("../../components/DataTable", () => ({
  default: ({ columns }: { columns: GridColDef[] }) => {
    table.columns = columns;
    return null;
  },
}));

const me = { user_id: "u1", name: "Robin Admin", email: "robin@example.com", role: "admin" };

function serve(hostedV2: boolean | null) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/members")) return new Response(JSON.stringify([me]), { status: 200 });
    if (url.endsWith("/feature-flags"))
      return hostedV2 === null
        ? new Response("{}", { status: 500 })
        : new Response(JSON.stringify({ flags: [{ key: "hosted_v2", enabled: hostedV2 }] }), { status: 200 });
    if (url.endsWith("/hosted-people")) return new Response(JSON.stringify({ people: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The name, email and joined columns' layout, and what the name cell draws. */
function layout() {
  const byField = new Map(table.columns.map((column) => [column.field, column]));
  const name = byField.get("name")!;
  return {
    nameMinWidth: name.minWidth,
    emailMinWidth: byField.get("email")!.minWidth,
    joinedWidth: byField.get("created_at")!.width,
    nameCell: name.renderCell!({ row: me } as never),
  };
}

// Main `807a1f94d`'s columns.
const MAIN = { nameMinWidth: 140, emailMinWidth: 200, joinedWidth: 140, nameCell: "Robin Admin (you)" };

describe("the Members columns", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    table.columns = [];
  });

  for (const [what, hostedV2] of [
    ["off", false],
    ["unreadable", null],
  ] as const) {
    it(`are main's exactly for an admin when the flag is ${what}`, async () => {
      auth.canAdmin = true;
      const fetchMock = serve(hostedV2);
      render(<MembersSection tenantId="t1" selfId="u1" />);
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/feature-flags"))).toBe(true),
      );
      await waitFor(() => expect(table.columns.length).toBeGreaterThan(0));
      expect(layout()).toEqual(MAIN);
    });
  }

  it("are main's exactly for a member, who never reads the flag", async () => {
    auth.canAdmin = false;
    const fetchMock = serve(true);
    render(<MembersSection tenantId="t1" selfId="u1" />);
    await waitFor(() => expect(table.columns.length).toBeGreaterThan(0));
    expect(layout()).toEqual(MAIN);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/feature-flags"))).toBe(false);
  });

  it("take the designer's wrap and widths with v2 on", async () => {
    auth.canAdmin = true;
    serve(true);
    render(<MembersSection tenantId="t1" selfId="u1" />);
    await waitFor(() => expect(layout().nameMinWidth).toBe(150));
    const { nameCell, ...widths } = layout();
    expect(widths).toEqual({ nameMinWidth: 150, emailMinWidth: 190, joinedWidth: 120 });
    // The name is wrapped in its own cell rather than left as plain text.
    expect(typeof nameCell).not.toBe("string");
  });
});
