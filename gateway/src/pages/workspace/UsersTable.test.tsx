import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../../data/api";
import UsersTable from "./UsersTable";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const LAST_ADMIN = "This is the workspace's last admin. Make someone else an admin first.";
const SERVICE_ACCOUNT = "Agents added with the shared registration token act with this account's role, so it can't be made an admin.";

function member(overrides: Partial<Member> & { user_id: string; name: string }): Member {
  return {
    email: `${overrides.name.toLowerCase()}@example.com`,
    role: "member",
    created_at: "2026-01-01",
    service_account: false,
    organization_role: "member",
    via_organization: false,
    can_change_role: false,
    change_role_blocked_reason: null,
    can_remove: false,
    remove_blocked_reason: null,
    can_receive_transfer: true,
    ...overrides,
  };
}

const ME = member({
  user_id: "me",
  name: "Me",
  role: "admin",
  can_change_role: true,
  can_remove: true,
});
const BOB = member({ user_id: "bob", name: "Bob", can_change_role: true, can_remove: true });
const ORG_ADMIN = member({
  user_id: "oa",
  name: "Olga",
  role: "admin",
  organization_role: "org_admin",
  via_organization: true,
});
const ROBOT = member({
  user_id: "robot",
  name: "Robot",
  service_account: true,
  change_role_blocked_reason: SERVICE_ACCOUNT,
  can_remove: true,
});

interface Rendered {
  onChanged: ReturnType<typeof vi.fn>;
  onSelfChanged: ReturnType<typeof vi.fn>;
  onLeft: ReturnType<typeof vi.fn>;
}

function renderTable(
  members: Member[],
  { administers = true, canOpenOrganizationUsers = true } = {},
): Rendered {
  const handlers = {
    onChanged: vi.fn(async () => {}),
    onSelfChanged: vi.fn(async () => {}),
    onLeft: vi.fn(),
  };
  render(
    <MemoryRouter>
      <UsersTable
        tenantId="t1"
        workspaceName="Acme"
        members={members}
        selfId="me"
        administers={administers}
        canOpenOrganizationUsers={canOpenOrganizationUsers}
        {...handlers}
      />
    </MemoryRouter>,
  );
  return handlers;
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

function stubFetch(answer: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof stubFetch>, method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);
}

describe("UsersTable", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names each person, marks you, and says what they act as", () => {
    renderTable([ME, BOB, ORG_ADMIN, ROBOT]);

    expect(screen.getByText("(you)")).toBeTruthy();
    expect(screen.getByText("bob@example.com")).toBeTruthy();
    expect(screen.getByText("Workspace admin")).toBeTruthy();
    expect(screen.getByText("Org admin")).toBeTruthy();
    expect(screen.getAllByText("Member")).toHaveLength(2);
    expect(screen.getByText("Service account")).toBeTruthy();
    const via = screen.getByRole("link", { name: "via organization" });
    expect(via.getAttribute("href")).toBe("/settings/org/users");
  });

  it("calls an org admin with their own membership an Org admin too", () => {
    renderTable([
      member({ user_id: "oam", name: "Oscar", role: "member", organization_role: "org_admin" }),
    ]);

    expect(screen.getByText("Org admin")).toBeTruthy();
    expect(screen.queryByText("Member")).toBeNull();
  });

  it("offers each row what the server allows, and says why when it doesn't", () => {
    renderTable([ME, BOB, ORG_ADMIN, ROBOT]);

    expect(menuItems("Bob")).toEqual([
      { label: "Change role", reason: null },
      { label: "Remove from workspace", reason: null },
    ]);
    expect(menuItems("Me")).toEqual([
      { label: "Step down to Member", reason: null },
      { label: "Leave workspace", reason: null },
    ]);
    expect(menuItems("Olga")).toEqual([
      { label: "Change role", reason: "An org admin's role is changed in Organization settings." },
      { label: "Remove from workspace", reason: "An org admin is removed in Organization settings." },
    ]);
    expect(menuItems("Robot")).toEqual([
      { label: "Change role", reason: SERVICE_ACCOUNT },
      { label: "Remove from workspace", reason: null },
    ]);
  });

  it("holds the last admin's own row with the server's reason", () => {
    renderTable([
      {
        ...ME,
        can_change_role: false,
        change_role_blocked_reason: LAST_ADMIN,
        can_remove: false,
        remove_blocked_reason: LAST_ADMIN,
      },
    ]);

    expect(menuItems("Me")).toEqual([
      { label: "Step down to Member", reason: LAST_ADMIN },
      { label: "Leave workspace", reason: LAST_ADMIN },
    ]);
  });

  it("shows a member the roster with nothing to act on", () => {
    renderTable([{ ...ME, role: "member", can_change_role: false, can_remove: false }, BOB], {
      administers: false,
      canOpenOrganizationUsers: false,
    });

    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  it("says 'via organization' without a link to someone who can't open it", () => {
    renderTable([ORG_ADMIN], { canOpenOrganizationUsers: false });

    expect(screen.getByText("via organization")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "via organization" })).toBeNull();
  });

  it("changes a role through the dialog, then reads the roster again", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify(BOB)));
    const { onChanged, onSelfChanged } = renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Bob")).getByText("Change role"));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText(/Workspace admin/));
    fireEvent.click(save);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [[url, init]] = calls(fetchMock, "PATCH");
    expect(url).toContain("/tenants/t1/members/bob");
    expect(JSON.parse(String(init?.body))).toEqual({ role: "admin" });
    expect(onSelfChanged).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in the dialog rather than closing it", async () => {
    stubFetch(() => new Response(JSON.stringify({ detail: "Cannot demote the last admin" }), { status: 409 }));
    renderTable([ME, { ...BOB, role: "admin" }]);

    fireEvent.click(within(openMenu("Bob")).getByText("Change role"));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(/^Member/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("Cannot demote the last admin")).toBeTruthy();
  });

  it("steps you down after a confirm, and reads your permissions again", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify(ME)));
    const { onChanged, onSelfChanged } = renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Me")).getByText("Step down to Member"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Step down" }));

    await waitFor(() => expect(onSelfChanged).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    const [[url, init]] = calls(fetchMock, "PATCH");
    expect(url).toContain("/tenants/t1/members/me");
    expect(JSON.parse(String(init?.body))).toEqual({ role: "member" });
  });

  it("sends whoever still owns agents to each one first", async () => {
    stubFetch((url) =>
      url.endsWith("/agents")
        ? new Response(
            JSON.stringify([
              { id: "a1", name: "helper", display_name: "Helper", owner_id: "bob", can_transfer: true, transfer_blocked_reason: null },
              { id: "a2", name: "laptop", display_name: null, owner_id: "bob", can_transfer: false, transfer_blocked_reason: "This agent is managed on its owner's device, with their sign-ins, and can't be transferred." },
              { id: "a3", name: "mine", display_name: null, owner_id: "me", can_transfer: true, transfer_blocked_reason: null },
            ]),
          )
        : new Response("{}"),
    );
    renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from workspace"));
    const dialog = screen.getByRole("dialog");

    expect(await within(dialog).findByText(/Bob still owns 2 agents here/)).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Helper" }).getAttribute("href")).toBe("/agents/a1");
    expect(within(dialog).getByRole("link", { name: "laptop" })).toBeTruthy();
    expect(within(dialog).getByText(/managed on its owner's device/)).toBeTruthy();
    expect(within(dialog).queryByRole("link", { name: "mine" })).toBeNull();
    const remove = within(dialog).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });

  /** Answers the agents list, the removal preview and the removal itself. */
  function stubRemoval({
    heir,
    warning = null,
    handed = {},
  }: {
    heir: { user_id: string; name: string; email: string } | null;
    warning?: string | null;
    handed?: Record<string, number>;
  }) {
    return stubFetch((url, init) => {
      if (url.endsWith("/agents")) return new Response("[]");
      if (url.endsWith("/removal")) return new Response(JSON.stringify({ handed_over_to: heir }));
      if (init?.method === "DELETE")
        return new Response(
          JSON.stringify({ ok: true, warning, handed_over_to: heir, handed_over: handed }),
        );
      return new Response("{}");
    });
  }

  const ANN = { user_id: "ann", name: "Ann", email: "ann@example.com" };

  it("names who receives what a removed person owns, then says what passed", async () => {
    const fetchMock = stubRemoval({ heir: { user_id: "me", name: "Me", email: "me@example.com" }, handed: { room: 2, template: 1 } });
    const { onChanged, onLeft } = renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from workspace"));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(/passes to you\. Chats stay as they are/)).toBeTruthy();
    expect(calls(fetchMock, "GET").some(([url]) => url.includes("/tenants/t1/members/bob/removal"))).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [[url]] = calls(fetchMock, "DELETE");
    expect(url).toContain("/tenants/t1/members/bob");
    expect(onLeft).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Removed Bob. What they owned there passed to you: 2 rooms, 1 template."),
    ).toBeTruthy();
  });

  it("names another admin when the server would hand things to them", async () => {
    stubRemoval({ heir: ANN });
    renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from workspace"));

    expect(
      await within(screen.getByRole("dialog")).findByText(/passes to Ann \(ann@example\.com\)/),
    ).toBeTruthy();
  });

  it("says what they own stays theirs when there is no other admin", async () => {
    stubRemoval({ heir: null });
    renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from workspace"));

    expect(
      await within(screen.getByRole("dialog")).findByText(/no other admin, so what they own here stays theirs/),
    ).toBeTruthy();
  });

  it("shows the sign-ins the removal could not revoke", async () => {
    stubRemoval({ heir: ANN, warning: "Could not revoke the GitHub sign-in; revoke it at GitHub." });
    const { onChanged } = renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from workspace"));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText(/passes to Ann/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText(/Could not revoke the GitHub sign-in/)).toBeTruthy();
    expect(screen.getByText("Removed Bob. Nothing they owned there changed hands.")).toBeTruthy();
  });

  it("still lets you remove when the preview can't be read, saying so", async () => {
    stubFetch((url) =>
      url.endsWith("/removal")
        ? new Response(JSON.stringify({ detail: "Boom" }), { status: 500 })
        : new Response("[]"),
    );
    renderTable([ME, BOB]);

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from workspace"));
    const dialog = screen.getByRole("dialog");

    expect(await within(dialog).findByText(/Couldn't check who would receive what they own/)).toBeTruthy();
    const remove = within(dialog).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
  });

  it("leaves the workspace from your own row, then follows the session", async () => {
    stubRemoval({ heir: ANN });
    const { onChanged, onLeft } = renderTable([ME, { ...BOB, role: "admin" }]);

    fireEvent.click(within(openMenu("Me")).getByText("Leave workspace"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Leave Acme?")).toBeTruthy();
    expect(
      await within(dialog).findByText(/You will lose access to this workspace.*passes to Ann/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave workspace" }));

    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
    expect(await screen.findByText(/^You left the workspace\./)).toBeTruthy();
  });
});
