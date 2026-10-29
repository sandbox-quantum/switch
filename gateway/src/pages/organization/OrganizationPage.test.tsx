import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GridColDef } from "@mui/x-data-grid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import OrganizationPage from "./OrganizationPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

/** A cell's text as the grid would show it: through `valueGetter`, then
 * `valueFormatter`. */
function cellText(
  column: GridColDef<Record<string, unknown>>,
  row: Record<string, unknown>,
): string {
  const call = (fn: unknown, ...args: unknown[]) =>
    (fn as (...a: unknown[]) => unknown)(...args);
  let value: unknown = row[column.field];
  if (column.valueGetter) value = call(column.valueGetter, value, row, column, null);
  if (column.valueFormatter) value = call(column.valueFormatter, value, row, column, null);
  return String(value ?? "");
}

// The data grid renders no rows under jsdom; this draws every cell plainly.
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
              {column.renderCell ? column.renderCell({ row } as never) : cellText(column, row)}
            </span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

function session(organizationRole: "org_admin" | "member", canAdd: boolean): Session {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: organizationRole === "org_admin" ? ("admin" as const) : ("member" as const),
    organization_role: organizationRole,
    organization_id: "o1",
  };
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant,
    tenants: [tenant],
    state: "ready",
    can_create_workspace: true,
    can_add_workspace: canAdd,
    invite_email_enabled: false,
  };
}

function answer(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/gateway/, "").split("?")[0];
    const key = `${init?.method ?? "GET"} ${path}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 404 });
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const workspace = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  role: "admin",
  organization_role: "org_admin",
  organization_id: "o1",
});

describe("OrganizationPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an organization admin its members and audit log", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: session("org_admin", true),
      switchTo: vi.fn(),
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    answer({
      "GET /organizations": [{ id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" }],
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [
        { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01" },
      ],
      "GET /organizations/current/audit-events": [
        {
          id: "e1",
          occurred_at: "2026-01-02",
          actor_user_id: "u2",
          action: "organization.role_changed",
          target_type: "user",
          target_id: "u2",
          details: { from: "member", to: "org_admin", platform_access: true },
        },
      ],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText("Acme Inc")).toBeTruthy();
    expect(await screen.findByText("Acme (current)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Members" })).toBeTruthy();
    expect(await screen.findByText("Organization role changed")).toBeTruthy();
    expect(screen.getByText("Bob (platform operator)")).toBeTruthy();
  });

  it("shows a member only the workspaces, with nothing to add", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: session("member", false),
      switchTo: vi.fn(),
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    answer({
      "GET /organizations": [{ id: "o1", slug: "acme", name: "Acme Inc", role: "member" }],
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText("Acme (current)")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Members" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Audit log" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add workspace" })).toBeNull();
  });

  it("adds a workspace and lists it", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: session("org_admin", true),
      switchTo: vi.fn(),
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    const routes: Record<string, unknown> = {
      "GET /organizations": [],
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "POST /organizations/current/workspaces": workspace("t2", "Research"),
    };
    const fetchMock = answer(routes);

    render(<OrganizationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add workspace" }));
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: "Research" } });
    routes["GET /organizations/current/workspaces"] = [
      workspace("t1", "Acme"),
      workspace("t2", "Research"),
    ];
    fireEvent.click(screen.getAllByRole("button", { name: "Add workspace" }).at(-1)!);

    expect(await screen.findByText("Research")).toBeTruthy();
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ name: "Research" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
