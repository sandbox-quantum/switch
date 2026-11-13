import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CurrentOrganization,
  OrganizationMemberEntry,
  OrganizationWorkspace,
} from "../../../data/api";
import { answerFetch } from "../../../test/answerFetch";
import OrganizationWorkspacesSettings from "./OrganizationWorkspacesSettings";

vi.mock("../../../components/DataTable", () => import("../../../test/FakeDataTable"));

const auth = vi.hoisted(() => ({
  canAddWorkspace: true,
  currentTenantId: "w1" as string | null,
  switchTo: vi.fn(async (_id: string) => {}),
  recheck: vi.fn(async () => {}),
}));

vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({
    session: {
      user: { id: "me", name: "Me", email: "me@example.com", is_operator: false },
      tenant: auth.currentTenantId
        ? {
            id: auth.currentTenantId,
            slug: auth.currentTenantId,
            name: "Current",
            role: "admin",
            organization_role: null,
            organization_id: "o1",
            archived_at: null,
          }
        : null,
      tenants: [],
      state: "ready",
      can_create_workspace: false,
      can_add_workspace: auth.canAddWorkspace,
      invite_email_enabled: false,
    },
    switchTo: auth.switchTo,
    recheck: auth.recheck,
  }),
}));

function org(overrides: Partial<CurrentOrganization> = {}): CurrentOrganization {
  return {
    id: "o1",
    slug: "acme",
    name: "Acme Org",
    role: "org_admin",
    members_from_directory: false,
    directory_takes_changes: false,
    administers: true,
    can_manage_members: true,
    ...overrides,
  };
}

function workspace(overrides: Partial<OrganizationWorkspace> & { id: string; name: string }): OrganizationWorkspace {
  return {
    slug: overrides.id,
    role: "admin",
    organization_role: null,
    organization_id: "o1",
    archived_at: null,
    created_at: "2026-01-01",
    users: 3,
    agents: 1,
    rooms: 2,
    admins: ["Alice", "Bob"],
    can_archive: true,
    archive_blocked_reason: null,
    can_restore: false,
    ...overrides,
  };
}

function member(
  overrides: Partial<OrganizationMemberEntry> & { user_id: string; name: string },
): OrganizationMemberEntry {
  return {
    email: `${overrides.name.toLowerCase()}@example.com`,
    role: "member",
    created_at: "2026-01-01",
    service_account: false,
    warning: null,
    can_change_role: true,
    can_grant_org_admin: false,
    can_remove: true,
    workspaces: [],
    ...overrides,
  };
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("menu");
}

function menuItems(name: string): { label: string; reason: string | null }[] {
  const menu = openMenu(name);
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((item) => ({
      label: item.querySelector(".MuiListItemText-primary")?.textContent ?? "",
      reason:
        item.getAttribute("aria-disabled") === "true"
          ? (item.querySelector(".MuiListItemText-secondary")?.textContent ?? "")
          : null,
    }));
  fireEvent.keyDown(menu, { key: "Escape" });
  return items;
}

describe("OrganizationWorkspacesSettings", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    auth.canAddWorkspace = true;
    auth.currentTenantId = "w1";
    auth.switchTo.mockClear();
    auth.recheck.mockClear();
  });

  it("lays out each workspace's row: current marker, status, stats, and admins", async () => {
    answerFetch({
      "GET /organizations/current": [200, org()],
      "GET /organizations/current/workspaces": [
        200,
        [
          workspace({ id: "w1", name: "Acme", users: 3, agents: 1, rooms: 2, admins: ["Alice", "Bob"] }),
          workspace({
            id: "w2",
            name: "Beta",
            archived_at: "2026-02-01",
            users: 1,
            agents: 0,
            rooms: 1,
            admins: ["Alice", "Bob", "Carol"],
          }),
          workspace({ id: "w3", name: "Gamma", users: 5, agents: 2, rooms: 3, admins: [] }),
        ],
      ],
    });

    render(<OrganizationWorkspacesSettings />);

    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("(current)")).toBeTruthy();
    expect(within(screen.getByTestId("row-w1")).getByText("Active")).toBeTruthy();
    expect(within(screen.getByTestId("row-w2")).getByText("Archived")).toBeTruthy();

    // Stats: icon + number pairs, with a singular/plural aria label.
    expect(screen.getByRole("img", { name: "3 users" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "1 agent" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 rooms" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "0 agents" })).toBeTruthy();

    // Admins: two names, then a muted "+N" listing the rest.
    expect(within(screen.getByTestId("row-w1")).getByText("Alice, Bob")).toBeTruthy();
    expect(within(screen.getByTestId("row-w2")).getByText("Alice, Bob")).toBeTruthy();
    expect(within(screen.getByTestId("row-w2")).getByText("+1")).toBeTruthy();
    expect(screen.getByLabelText("Alice, Bob, Carol")).toBeTruthy();

    // No admins at all: a muted dash with a tooltip explaining why.
    expect(screen.getByText("—")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "No one in this workspace has the workspace admin role yet. Org admins can still administer it.",
      ),
    ).toBeTruthy();
  });

  it("disables archiving with the server's own reason", async () => {
    answerFetch({
      "GET /organizations/current": [200, org()],
      "GET /organizations/current/workspaces": [
        200,
        [
          workspace({
            id: "w2",
            name: "Beta",
            can_archive: false,
            archive_blocked_reason: "This is the organization's last workspace.",
          }),
        ],
      ],
    });

    render(<OrganizationWorkspacesSettings />);
    await screen.findByText("Beta");

    expect(menuItems("Beta")).toContainEqual({
      label: "Archive workspace",
      reason: "This is the organization's last workspace.",
    });
  });

  it("archives through the confirm dialog, then reads the list again", async () => {
    auth.currentTenantId = "w9";
    const calls = answerFetch({
      "GET /organizations/current": [200, org()],
      "GET /organizations/current/workspaces": [
        [200, [workspace({ id: "w2", name: "Beta", users: 4 })]],
        [200, [workspace({ id: "w2", name: "Beta", users: 4, archived_at: "2026-03-01" })]],
      ],
      "POST /organizations/current/workspaces/w2/archive": [
        200,
        { id: "w2", name: "Beta", archived_at: "2026-03-01" },
      ],
    });

    render(<OrganizationWorkspacesSettings />);
    await screen.findByText("Beta");
    expect(screen.getByText("Active")).toBeTruthy();

    fireEvent.click(within(openMenu("Beta")).getByText("Archive workspace"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Archive workspace")).toBeTruthy();
    expect(
      within(dialog).getByText(/Its 4 users keep their accounts but can no longer open it/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(screen.getByText("Archived")).toBeTruthy());
    expect(calls.some((c) => c.method === "POST" && c.path === "/organizations/current/workspaces/w2/archive")).toBe(
      true,
    );
    expect(calls.filter((c) => c.method === "GET" && c.path === "/organizations/current/workspaces")).toHaveLength(2);
    expect(await screen.findByText("Archived Beta.")).toBeTruthy();
  });

  it("restores a workspace at once, with no confirm", async () => {
    const calls = answerFetch({
      "GET /organizations/current": [200, org()],
      "GET /organizations/current/workspaces": [
        [200, [workspace({ id: "w2", name: "Beta", archived_at: "2026-02-01", can_restore: true })]],
        [200, [workspace({ id: "w2", name: "Beta" })]],
      ],
      "POST /organizations/current/workspaces/w2/restore": [200, { id: "w2", name: "Beta", archived_at: null }],
    });

    render(<OrganizationWorkspacesSettings />);
    await screen.findByText("Beta");

    fireEvent.click(within(openMenu("Beta")).getByText("Restore workspace"));

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/organizations/current/workspaces/w2/restore"),
      ).toBe(true),
    );
    expect(await screen.findByText("Restored Beta.")).toBeTruthy();
  });

  it("renames a workspace with the trimmed name", async () => {
    const calls = answerFetch({
      "GET /organizations/current": [200, org()],
      "GET /organizations/current/workspaces": [
        [200, [workspace({ id: "w1", name: "Acme" })]],
        [200, [workspace({ id: "w1", name: "New Name" })]],
      ],
      "PATCH /organizations/current/workspaces/w1": [200, { id: "w1", name: "New Name" }],
    });
    auth.currentTenantId = "w1";

    render(<OrganizationWorkspacesSettings />);
    await screen.findByText("Acme");

    fireEvent.click(within(openMenu("Acme")).getByText("Rename workspace"));
    const dialog = screen.getByRole("dialog");
    const field = within(dialog).getByLabelText("Workspace name") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "  New Name  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.path === "/organizations/current/workspaces/w1")).toBe(
        true,
      ),
    );
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/organizations/current/workspaces/w1");
    expect(patch?.body).toEqual({ name: "New Name" });
    expect(await screen.findByText("Renamed to New Name.")).toBeTruthy();
    expect(auth.recheck).toHaveBeenCalled();
  });

  it("pre-ticks a workspace's current admins, and saves exactly who is ticked", async () => {
    const members: OrganizationMemberEntry[] = [
      member({
        user_id: "alice",
        name: "Alice",
        workspaces: [{ id: "w1", name: "Acme", role: "admin", archived: false }],
      }),
      member({
        user_id: "bob",
        name: "Bob",
        workspaces: [{ id: "w1", name: "Acme", role: "member", archived: false }],
      }),
      member({
        user_id: "olga",
        name: "Olga",
        role: "org_admin",
        workspaces: [{ id: "w1", name: "Acme", role: "admin", archived: false }],
      }),
      member({
        user_id: "svc",
        name: "Registration",
        service_account: true,
        workspaces: [{ id: "w1", name: "Acme", role: "member", archived: false }],
      }),
    ];
    const calls = answerFetch({
      "GET /organizations/current": [200, org()],
      "GET /organizations/current/workspaces": [200, [workspace({ id: "w1", name: "Acme" })]],
      "GET /organizations/current/members": [200, members],
      "PUT /organizations/current/workspaces/w1/admins": [200, { id: "w1", name: "Acme", admins: ["Alice", "Bob"] }],
    });

    render(<OrganizationWorkspacesSettings />);
    await screen.findByText("Acme");

    fireEvent.click(within(openMenu("Acme")).getByText("Manage admins"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Admins of Acme")).toBeTruthy();
    // The org admin isn't offered: org admins administer every workspace already.
    expect(within(dialog).queryByText("Olga")).toBeNull();
    // Nor the registration service account, which the server never makes one.
    expect(within(dialog).queryByText("Registration")).toBeNull();

    const aliceCheckbox = within(dialog).getByRole("checkbox", { name: /Alice/ }) as HTMLInputElement;
    const bobCheckbox = within(dialog).getByRole("checkbox", { name: /Bob/ }) as HTMLInputElement;
    expect(aliceCheckbox.checked).toBe(true);
    expect(bobCheckbox.checked).toBe(false);

    fireEvent.click(bobCheckbox);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "PUT" && c.path === "/organizations/current/workspaces/w1/admins"),
      ).toBe(true),
    );
    const put = calls.find((c) => c.method === "PUT" && c.path === "/organizations/current/workspaces/w1/admins");
    expect(put?.body).toEqual({ user_ids: ["alice", "bob"] });
    expect(await screen.findByText("Acme now has 2 admins.")).toBeTruthy();
  });

  it("refuses a duplicate workspace name before asking, and sends the trimmed name otherwise", async () => {
    const calls = answerFetch({
      "GET /organizations/current": [200, org({ name: "Acme Org" })],
      "GET /organizations/current/workspaces": [
        [200, [workspace({ id: "w1", name: "Acme" })]],
        [200, [workspace({ id: "w1", name: "Acme" }), workspace({ id: "w4", name: "Quantum Chemistry" })]],
      ],
      "POST /organizations/current/workspaces": [200, { id: "w4", name: "Quantum Chemistry" }],
    });

    render(<OrganizationWorkspacesSettings />);
    await screen.findByText("Acme");

    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    const dialog = screen.getByRole("dialog");
    const field = within(dialog).getByLabelText("Workspace name") as HTMLInputElement;

    fireEvent.change(field, { target: { value: "acme" } });
    expect(
      within(dialog).getByText("Acme Org already has a workspace called “Acme”."),
    ).toBeTruthy();
    const createButton = within(dialog).getByRole("button", { name: "Create workspace" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(field, { target: { value: "  Quantum Chemistry  " } });
    expect(createButton.disabled).toBe(false);
    fireEvent.click(createButton);

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ name: "Quantum Chemistry" });
    expect(await screen.findByText("Created Quantum Chemistry.")).toBeTruthy();
    // The session too: the switcher lists it, and the allowance may be used up.
    await waitFor(() => expect(auth.recheck).toHaveBeenCalled());
  });

  it("refuses renaming to another workspace's name before asking, but not to its own", async () => {
    const calls = answerFetch({
      "GET /organizations/current": [200, org({ name: "Acme Org" })],
      "GET /organizations/current/workspaces": [
        200,
        [workspace({ id: "w1", name: "Acme" }), workspace({ id: "w2", name: "Beta" })],
      ],
    });

    render(<OrganizationWorkspacesSettings />);
    await screen.findByText("Beta");

    fireEvent.click(within(openMenu("Beta")).getByText("Rename workspace"));
    const dialog = screen.getByRole("dialog");
    const field = within(dialog).getByLabelText("Workspace name") as HTMLInputElement;
    const renameButton = within(dialog).getByRole("button", { name: "Rename" }) as HTMLButtonElement;

    fireEvent.change(field, { target: { value: " ACME " } });
    expect(within(dialog).getByText("Acme Org already has a workspace called “Acme”.")).toBeTruthy();
    expect(renameButton.disabled).toBe(true);

    fireEvent.change(field, { target: { value: "BETA" } });
    expect(within(dialog).queryByText(/already has a workspace/)).toBeNull();
    expect(renameButton.disabled).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("gives a viewer who isn't an organization admin no working actions", async () => {
    auth.canAddWorkspace = false;
    answerFetch({
      "GET /organizations/current": [200, org({ administers: false, role: null })],
      "GET /organizations/current/workspaces": [200, [workspace({ id: "w1", name: "Acme" })]],
    });

    render(<OrganizationWorkspacesSettings />);

    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  });

  it("shows a load failure rather than an empty table", async () => {
    answerFetch({
      "GET /organizations/current": [200, org()],
      "GET /organizations/current/workspaces": [500, { detail: "Could not reach the database." }],
    });

    render(<OrganizationWorkspacesSettings />);

    expect(await screen.findByText("Could not reach the database.")).toBeTruthy();
  });
});
