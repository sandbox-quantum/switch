import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../../data/AuthContext";
import type {
  CurrentOrganization,
  OrganizationMemberEntry,
  OrganizationWorkspace,
} from "../../../data/api";
import { answerFetch } from "../../../test/answerFetch";
import OrganizationUsersSettings from "./OrganizationUsersSettings";

vi.mock("../../../components/DataTable", () => import("../../../test/FakeDataTable"));
vi.mock("../../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const ORGANIZATION: CurrentOrganization = {
  id: "org-1",
  slug: "acme",
  name: "Acme",
  role: "org_admin",
  members_from_directory: false,
  directory_takes_changes: false,
  administers: true,
  can_manage_members: true,
};

function member(
  overrides: Partial<OrganizationMemberEntry> & { user_id: string; name: string },
): OrganizationMemberEntry {
  return {
    email: `${overrides.name.toLowerCase()}@example.com`,
    role: "member",
    created_at: "2026-01-01",
    warning: null,
    service_account: false,
    can_change_role: true,
    change_role_blocked_reason: null,
    can_grant_org_admin: true,
    can_remove: true,
    remove_blocked_reason: null,
    workspaces: [],
    ...overrides,
  };
}

function workspace(id: string, name: string, archived = false): OrganizationWorkspace {
  return {
    id,
    slug: id,
    name,
    role: "admin",
    organization_role: "org_admin",
    organization_id: "org-1",
    archived_at: archived ? "2026-02-01T00:00:00Z" : null,
    created_at: "2026-01-01",
    users: 1,
    agents: 0,
    rooms: 0,
    admins: [],
    can_archive: false,
    archive_blocked_reason: null,
    can_restore: archived,
  };
}

const ME = member({
  user_id: "me",
  name: "Me",
  role: "org_admin",
  workspaces: [{ id: "w1", name: "Core", role: "admin", archived: false }],
});
const BOB = member({
  user_id: "bob",
  name: "Bob",
  workspaces: [
    { id: "w1", name: "Core", role: "member", archived: false },
    { id: "w3", name: "Old", role: "admin", archived: true },
  ],
});
const LONE = member({ user_id: "lone", name: "Lone", role: "org_admin", workspaces: [] });
const DRIFTER = member({ user_id: "drifter", name: "Drifter", workspaces: [] });

const WORKSPACES = [workspace("w1", "Core"), workspace("w2", "Lab"), workspace("w3", "Old", true)];

function signedIn() {
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "me", name: "Me", email: "me@example.com", is_operator: false },
      tenant: workspace("w1", "Core"),
      tenants: [],
      state: "ready",
      can_create_workspace: true,
      can_add_workspace: true,
      invite_email_enabled: false,
      can_manage_connector_apps: false,
    },
    refresh: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useAuth>);
}

function renderPage(organization = ORGANIZATION) {
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <OrganizationUsersSettings organization={organization} onChanged={onChanged} />
    </MemoryRouter>,
  );
  return onChanged;
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

function choose(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: label }));
  fireEvent.click(within(screen.getByRole("listbox")).getByText(option));
}

describe("OrganizationUsersSettings", () => {
  beforeEach(signedIn);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists each person with the workspaces they are in and their role there", async () => {
    answerFetch({
      "GET /organizations/current/members": [200, [ME, BOB, LONE, DRIFTER]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
    });
    renderPage();

    const bob = await screen.findByTestId("row-bob");
    expect(within(bob).getByText("Core")).toBeTruthy();
    expect(within(bob).getByText("Old · Admin (archived)")).toBeTruthy();
    expect(within(screen.getByTestId("row-lone")).getByText("Organization-wide")).toBeTruthy();
    expect(within(screen.getByTestId("row-drifter")).getByText("No workspace")).toBeTruthy();
    expect(within(screen.getByTestId("row-me")).getByText("(you)")).toBeTruthy();
  });

  it("offers what the server says, and says why the rest can't be done", async () => {
    answerFetch({
      "GET /organizations/current/members": [200, [ME, BOB, LONE]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
    });
    renderPage();
    await screen.findByTestId("row-bob");

    expect(menuItems("Bob")).toEqual([
      { label: "Make Org admin", reason: null },
      { label: "Add to a workspace", reason: null },
      { label: "Change role in a workspace", reason: null },
      { label: "Remove from a workspace", reason: null },
      {
        label: "Remove from organization",
        reason: "Remove them from the organization's workspaces first: Core, Old.",
      },
    ]);
    expect(menuItems("Lone").map((item) => [item.label, item.reason !== null])).toEqual([
      ["Make Member", false],
      ["Add to a workspace", false],
      ["Change role in a workspace", true],
      ["Remove from a workspace", true],
      ["Remove from organization", false],
    ]);
  });

  it("tells the only org admin to make someone else one first, not to step down", async () => {
    const reason = "This is the organization's only org admin. Make someone else an org admin first.";
    const onlyMe = {
      ...ME,
      can_change_role: false,
      change_role_blocked_reason: reason,
      can_remove: false,
      remove_blocked_reason: reason,
    };
    answerFetch({
      "GET /organizations/current/members": [200, [onlyMe, BOB]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
    });
    renderPage();
    await screen.findByTestId("row-me");

    expect(menuItems("Me")).toEqual([
      { label: "Step down to Member", reason },
      { label: "Add to a workspace", reason: null },
      {
        label: "Change role in a workspace",
        reason: "An org admin administers every workspace already; their role in one is not changed here.",
      },
      {
        label: "Leave a workspace",
        reason: `An org admin stays in every workspace while they are one. ${reason}`,
      },
      { label: "Leave organization", reason },
    ]);
  });

  it("greys Invite users with the reason while every workspace is archived", async () => {
    answerFetch({
      "GET /organizations/current/members": [200, [ME, BOB]],
      "GET /organizations/current/workspaces": [200, [workspace("w3", "Old", true)]],
    });
    renderPage();
    await screen.findByTestId("row-bob");

    const invite = screen.getByRole("button", { name: "Invite users" }) as HTMLButtonElement;
    expect(invite.disabled).toBe(true);
    expect(invite.parentElement?.getAttribute("aria-label")).toBe("Every workspace in the organization is archived.");
  });

  it("says why no one can be added to a workspace while the workspaces can't be read", async () => {
    answerFetch({
      "GET /organizations/current/members": [200, [ME, BOB]],
      "GET /organizations/current/workspaces": [500, { detail: "Could not reach the database." }],
    });
    renderPage();
    await screen.findByTestId("row-bob");

    await waitFor(() =>
      expect(menuItems("Bob").find((item) => item.label === "Add to a workspace")?.reason).toBe(
        "The organization's workspaces couldn't be loaded.",
      ),
    );
  });

  it("adds someone to a workspace they are not in, as the role picked", async () => {
    const calls = answerFetch({
      "GET /organizations/current/members": [200, [ME, BOB]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
      "POST /organizations/current/workspaces/w2/members": [
        201,
        { id: "w2", name: "Lab", role: "admin", archived: false },
      ],
    });
    renderPage();
    await screen.findByTestId("row-bob");

    fireEvent.click(within(openMenu("Bob")).getByText("Add to a workspace"));
    // Only Lab: Bob is in Core, and Old is archived.
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Workspace" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Lab",
    ]);
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Lab"));
    fireEvent.click(screen.getByRole("radio", { name: /Workspace admin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toEqual({
        method: "POST",
        path: "/organizations/current/workspaces/w2/members",
        body: { user_id: "bob", role: "admin" },
      }),
    );
    const added = await screen.findByText("Added Bob to Lab as Workspace admin.");
    // A plain success is the snackbar's, not a notice left on the page.
    expect(added.closest(".MuiAlert-root")).toBeNull();
  });

  it("changes someone's role in one of their workspaces", async () => {
    const calls = answerFetch({
      "GET /organizations/current/members": [200, [ME, BOB]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
      "PATCH /organizations/current/workspaces/w1/members/bob": [
        200,
        { id: "w1", name: "Core", role: "admin", archived: false },
      ],
    });
    renderPage();
    await screen.findByTestId("row-bob");

    fireEvent.click(within(openMenu("Bob")).getByText("Change role in a workspace"));
    choose("Workspace", "Core");
    fireEvent.click(screen.getByRole("radio", { name: /Workspace admin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "admin" }),
    );
    expect(await screen.findByText("Bob is now Workspace admin of Core.")).toBeTruthy();
  });

  it("removes someone from a workspace once it has said who receives what they own", async () => {
    const calls = answerFetch({
      "GET /organizations/current/members": [200, [ME, BOB]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
      "GET /organizations/current/workspaces/w1/members/bob/removal": [
        200,
        { handed_over_to: { user_id: "me", name: "Me", email: "me@example.com" } },
      ],
      "DELETE /organizations/current/workspaces/w1/members/bob": [
        200,
        { ok: true, warning: null, handed_over_to: null, handed_over: {} },
      ],
    });
    renderPage();
    await screen.findByTestId("row-bob");

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from a workspace"));
    choose("Workspace", "Core");
    expect(await screen.findByText(/Bob will lose access to Core/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText(/Removed Bob from Core\./)).toBeTruthy();
  });

  it("makes someone Org admin once confirmed", async () => {
    const calls = answerFetch({
      "GET /organizations/current/members": [200, [ME, DRIFTER]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
      "PATCH /organizations/current/members/drifter": [
        200,
        { ...DRIFTER, role: "org_admin", warning: null },
      ],
    });
    const onChanged = renderPage();
    await screen.findByTestId("row-drifter");

    fireEvent.click(within(openMenu("Drifter")).getByText("Make Org admin"));
    fireEvent.click(screen.getByRole("button", { name: "Make Org admin" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "org_admin" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("makes an invite link to the workspace picked, through the organization", async () => {
    const calls = answerFetch({
      "GET /organizations/current/members": [200, [ME]],
      "GET /organizations/current/workspaces": [200, WORKSPACES],
      "POST /organizations/current/workspaces/w2/invitations": [
        201,
        {
          id: "i1",
          role: "member",
          email: null,
          expires_at: "2030-01-01",
          uses_remaining: 1,
          revoked_at: null,
          created_by: "me",
          created_at: "2029-12-25",
          token: "tok",
          email_delivery: "not_requested",
        },
      ],
    });
    renderPage();
    await screen.findByTestId("row-me");

    fireEvent.click(screen.getByRole("button", { name: "Invite users" }));
    // The archived workspace is not offered.
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Workspace" }));
    expect(within(screen.getByRole("listbox")).queryByText("Old")).toBeNull();
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Lab"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    choose("Role", "Member");
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));

    await waitFor(() =>
      expect(calls.some((c) => c.path === "/organizations/current/workspaces/w2/invitations")).toBe(
        true,
      ),
    );
  });

  it("shows the platform operator nothing to manage while the organization has an admin", async () => {
    answerFetch({});
    renderPage({ ...ORGANIZATION, role: null, administers: false, can_manage_members: false });

    expect(
      await screen.findByText(/you can manage this organization's users only while it has no admin/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite users" })).toBeNull();
  });

  describe("where changes go to the organization's account settings", () => {
    const TRUST = { ...ORGANIZATION, members_from_directory: true, directory_takes_changes: true };
    const ADMIN_BOB = { ...BOB, role: "org_admin" as const };
    const sent = (calls: ReturnType<typeof answerFetch>, method: string) =>
      calls.filter((c) => c.method === method).length;

    it("shows the roles as Switch Trust names them", async () => {
      answerFetch({
        "GET /organizations/current/members": [200, [ME, DRIFTER]],
        "GET /organizations/current/workspaces": [200, WORKSPACES],
      });
      renderPage(TRUST);

      expect(within(await screen.findByTestId("row-me")).getByText("Org Admin")).toBeTruthy();
      expect(within(screen.getByTestId("row-drifter")).getByText("Viewer")).toBeTruthy();
      expect(menuItems("Drifter").map((i) => i.label)).toContain("Make Org Admin");
    });

    it("says a promotion gives billing permissions in Switch Trust, and sends nothing on cancel", async () => {
      const calls = answerFetch({
        "GET /organizations/current/members": [200, [ME, DRIFTER]],
        "GET /organizations/current/workspaces": [200, WORKSPACES],
      });
      renderPage(TRUST);
      await screen.findByTestId("row-drifter");

      fireEvent.click(within(openMenu("Drifter")).getByText("Make Org Admin"));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/Org Admin in Switch Trust, with billing permissions/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(sent(calls, "PATCH")).toBe(0);
    });

    it("says a demotion makes the person a Viewer in Switch Trust, and sends it once confirmed", async () => {
      const calls = answerFetch({
        "GET /organizations/current/members": [200, [ME, ADMIN_BOB]],
        "GET /organizations/current/workspaces": [200, WORKSPACES],
        "PATCH /organizations/current/members/bob": [200, { ...BOB, warning: null }],
      });
      renderPage(TRUST);
      await screen.findByTestId("row-bob");

      fireEvent.click(within(openMenu("Bob")).getByText("Make Viewer"));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/earlier Switch Trust role is not kept/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Make Viewer" }));

      await waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "member" }),
      );
    });

    it("says a removal also removes the person from Switch Trust", async () => {
      answerFetch({
        "GET /organizations/current/members": [200, [ME, DRIFTER]],
        "GET /organizations/current/workspaces": [200, WORKSPACES],
      });
      renderPage(TRUST);
      await screen.findByTestId("row-drifter");

      fireEvent.click(within(openMenu("Drifter")).getByText("Remove from organization"));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/removed from the organization in Switch Trust/)).toBeTruthy();
    });

    it("says nothing of Switch Trust where changes stay in Switch", async () => {
      answerFetch({
        "GET /organizations/current/members": [200, [ME, DRIFTER]],
        "GET /organizations/current/workspaces": [200, WORKSPACES],
      });
      renderPage({ ...TRUST, directory_takes_changes: false });
      await screen.findByTestId("row-drifter");

      fireEvent.click(within(openMenu("Drifter")).getByText("Remove from organization"));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByText(/Switch Trust/)).toBeNull();
    });
  });
});
