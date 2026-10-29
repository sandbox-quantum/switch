import { cleanup, render, screen } from "@testing-library/react";
import type { GridColDef } from "@mui/x-data-grid";
import { afterEach, describe, expect, it, vi } from "vitest";
import MembersSection from "./MembersSection";

vi.mock("../../data/AuthContext", () => ({ useAuth: () => ({ refresh: vi.fn() }) }));

vi.mock("../../components/DataTable", () => ({
  default: ({
    rows,
    columns,
  }: {
    rows: Record<string, unknown>[];
    columns: GridColDef<Record<string, unknown>>[];
  }) => (
    <div>
      {rows.map((row) => (
        <div key={String(row.id)} data-testid={`row-${String(row.id)}`}>
          {columns.map((column) => (
            <span key={column.field}>
              {column.renderCell ? column.renderCell({ row } as never) : null}
            </span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

const member = (overrides: Record<string, unknown>) => ({
  name: "x",
  email: "x@example.com",
  role: "member",
  created_at: "2026-01-01",
  organization_role: "member",
  via_organization: false,
  ...overrides,
});

describe("MembersSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows organization admins read-only, and the rest manageable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              member({ user_id: "u2", name: "Bob", email: "bob@example.com" }),
              member({
                user_id: "u3",
                name: "Cy",
                email: "cy@example.com",
                role: "admin",
                organization_role: "org_admin",
                via_organization: true,
              }),
            ]),
          ),
      ),
    );

    render(<MembersSection tenantId="t1" selfId="u1" canAdmin isOwner />);

    expect(await screen.findByText("Org Admin, via organization")).toBeTruthy();
    expect(screen.queryByLabelText("Role for cy@example.com")).toBeNull();
    expect(screen.queryByLabelText("Remove cy@example.com")).toBeNull();
    expect(screen.getByLabelText("Role for bob@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Remove bob@example.com")).toBeTruthy();
  });
});
