import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentListEntry, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import { ALL_OFF, type FeatureFlags } from "../../data/featureFlags";
import { clickOutsideDialog } from "../../test/clickOutsideDialog";
import { providersQueryClient } from "../ai-providers/DeviceProviders";
import AgentListPage, { deviceLabels } from "./AgentListPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

/** Ada, signed in to Acme, as an admin of it or a member. */
function signedInAs(role: "admin" | "member", features: FeatureFlags = ALL_OFF) {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role,
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
    can_manage_connector_apps: false,
  } as unknown as Session;
  vi.mocked(useAuth).mockReturnValue({
    session,
    capabilities: capabilitiesOf(
      session,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role,
        administers: role === "admin",
        can_delete: false,
        can_manage_data_protection: false,
      },
      features,
    ),
  } as unknown as ReturnType<typeof useAuth>);
}

function agent(id: string, ownerId: string, extra: Partial<AgentListEntry> = {}): AgentListEntry {
  return {
    id,
    name: id,
    display_name: null,
    description: `${id} does things`,
    connector_type: "Claude Code",
    connection_model: "auto_session",
    tool_count: 3,
    model_count: 1,
    owner_id: ownerId,
    owner_name: ownerId === "u1" ? "Ada" : "Grace",
    oauth_client_id: null,
    created_at: "2026-11-01T10:00:00+00:00",
    parent_agent_id: null,
    known_agent_type: null,
    known_agent_options: null,
    can_manage: true,
    can_rename: true,
    can_edit_options: false,
    can_transfer: true,
    transfer_blocked_reason: null,
    suspension: null,
    status: "online",
    device: null,
    ...extra,
  };
}

type Route = [number, unknown];

function answer(routes: Record<string, Route | Route[]>) {
  const calls: { method: string; path: string }[] = [];
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value[0]) ? [...(value as Route[])] : [value as Route]]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      calls.push({ method, path });
      const queue = queues.get(`${method} ${path}`);
      const [status, body] = (queue && (queue.length > 1 ? queue.shift() : queue[0])) ?? [404, { detail: `unmocked ${method} ${path}` }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

/** The agents on screen, by the name each card's button reads; a dialog open over them hides them from the accessibility tree, not from the page. */
const cards = () =>
  screen.queryAllByRole("button", { name: /^Open /, hidden: true }).map((button) => button.getAttribute("aria-label")!.slice(5));

/** Picks `option` from the filter labelled `label`. */
async function pick(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Opens a card's actions menu. */
async function openActions(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: `${name} actions` }));
  return screen.findByRole("menu");
}

const show = () =>
  render(
    <MemoryRouter>
      <AgentListPage />
    </MemoryRouter>,
  );

describe("AgentListPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an admin every agent in the workspace as a card, with an Owner filter", async () => {
    signedInAs("admin");
    answer({ "GET /agents": [200, [agent("mine", "u1"), agent("theirs", "u2")]] });
    show();

    await waitFor(() => expect(cards()).toEqual(["mine", "theirs"]));
    expect(screen.getByText("Agents in Acme.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Owner" })).toBeTruthy();
    // Whose each one is, for an admin who sees everyone's.
    expect(screen.getByText("by Grace")).toBeTruthy();
    expect(screen.getAllByText("Online")).toHaveLength(2);
  });

  it("shows a member only their own agents, and says so", async () => {
    signedInAs("member");
    answer({ "GET /agents": [200, [agent("mine", "u1"), agent("theirs", "u2")]] });
    show();

    await waitFor(() => expect(cards()).toEqual(["mine"]));
    expect(screen.getByText("The agents you own in Acme.")).toBeTruthy();
    // One owner to pick from is no filter at all.
    expect(screen.queryByRole("combobox", { name: "Owner" })).toBeNull();
    expect(screen.queryByText(/^by /)).toBeNull();
  });

  it("opens an agent from its card", async () => {
    signedInAs("admin", { ...ALL_OFF, gateway_chats: true });
    answer({ "GET /agents": [200, [agent("mine", "u1")]] });
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <Routes>
          <Route path="/agents" element={<AgentListPage />} />
          <Route path="/chats/agents/:id" element={<p>chat page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open mine" }));
    expect(await screen.findByText("chat page")).toBeTruthy();
  });

  it("leaves only the add tile in an empty workspace, and it opens Add agent", async () => {
    signedInAs("member");
    answer({ "GET /agents": [200, []] });
    show();

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Add agent" })).toHaveLength(1));
    const add = screen.getByRole("button", { name: "Add agent" });
    expect(cards()).toEqual([]);
    // The tile says what to do; no sentence says the list is empty.
    expect(screen.queryByText(/No agents in Acme/)).toBeNull();
    // Nothing to filter or search.
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
    expect(screen.queryByLabelText("Search agents")).toBeNull();
    fireEvent.click(add);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("words a search that matches none of a member's agents for them", async () => {
    signedInAs("member");
    answer({ "GET /agents": [200, [agent("mine", "u1")]] });
    show();

    fireEvent.change(await screen.findByLabelText("Search agents"), { target: { value: "nothing like it" } });
    expect(await screen.findByText("None of your agents match these filters.")).toBeTruthy();
    expect(cards()).toEqual([]);
  });

  it("offers only the statuses some agent has", async () => {
    signedInAs("admin");
    answer({ "GET /agents": [200, [agent("a", "u1", { status: "offline" }), agent("b", "u1", { status: "not_tracked" })]] });
    show();

    await userEvent.setup().click(await screen.findByRole("combobox", { name: "Status" }));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All statuses", "Offline", "Not tracked"]);
  });

  it("says what a missing owner means, and names a sub-agent's parent", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [
        200,
        [
          agent("orphan", "u1", { owner_id: null, owner_name: null, created_at: "2026-11-03T10:00:00+00:00" }),
          agent("nameless", "u9", { owner_name: null, created_at: "2026-11-02T10:00:00+00:00" }),
          agent("child", "u1", { parent_agent_id: "orphan" }),
        ],
      ],
    });
    show();

    expect(await screen.findByText("No owner")).toBeTruthy();
    expect(screen.getByText("by an unknown owner")).toBeTruthy();
    expect(screen.getByText("under orphan · by Ada")).toBeTruthy();
  });

  it("says why the list could not load, rather than show an empty one", async () => {
    signedInAs("admin");
    answer({ "GET /agents": [503, { detail: "The database is unavailable." }] });
    show();

    expect(await screen.findByText(/Couldn't load the agents: The database is unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add agent" })).toBeNull();
  });

  it("offers a blocked transfer greyed, with the server's reason, and no delete where it may not", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [
        200,
        [
          agent("managed", "u2", {
            can_manage: false,
            can_rename: false,
            can_transfer: false,
            transfer_blocked_reason: "This agent is managed on its owner's device and can't be transferred.",
          }),
        ],
      ],
    });
    show();

    const menu = await openActions("managed");
    const transfer = within(menu).getByRole("menuitem", { name: /Transfer ownership/ });
    expect(transfer.getAttribute("aria-disabled")).toBe("true");
    expect(within(transfer).getByText(/can't be transferred/)).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Rename/ })).toBeNull();
  });

  it("has no actions menu on an agent the viewer may do nothing to", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [
        200,
        [agent("locked", "u2", { can_manage: false, can_rename: false, can_transfer: false })],
      ],
    });
    show();

    await waitFor(() => expect(cards()).toEqual(["locked"]));
    expect(screen.queryByRole("button", { name: "locked actions" })).toBeNull();
  });

  it("keeps the delete dialog open with the server's reason when the delete is refused", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [200, [agent("parent", "u1"), agent("child", "u1", { parent_agent_id: "parent" })]],
      "DELETE /agents/parent": [403, { detail: "Only the agent's owner or an admin can delete it." }],
    });
    show();

    fireEvent.click(within(await openActions("parent")).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    expect(within(dialog).getByText(/Its sub-agent stays, as a top-level agent/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Only the agent's owner or an admin can delete it.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delete agent" })).toBeTruthy();
  });

  it("refreshes the list when a delete is refused because the agent is already gone", async () => {
    signedInAs("admin");
    const calls = answer({
      "GET /agents": [
        [200, [agent("gone", "u1"), agent("kept", "u1")]],
        [200, [agent("kept", "u1")]],
      ],
      "DELETE /agents/gone": [404, { detail: "Agent not found: gone" }],
    });
    show();

    fireEvent.click(within(await openActions("gone")).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Agent not found: gone")).toBeTruthy();
    await waitFor(() => expect(cards()).toEqual(["kept"]));
    expect(calls.filter((call) => call.method === "GET" && call.path === "/agents")).toHaveLength(2);
  });

  it("keeps the delete dialog's words while it closes, though the list changes under it", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [
        [200, [agent("parent", "u1"), agent("child", "u1", { parent_agent_id: "parent" })]],
        // After the delete, the child has no parent, as the server answers.
        [200, [agent("child", "u1")]],
      ],
      "DELETE /agents/parent": [200, { ok: true, bridge_cleanup_failures: [] }],
    });
    show();

    fireEvent.click(within(await openActions("parent")).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByText('Deleted "parent".');
    await waitFor(() => expect(cards()).toEqual(["child"]));

    // Still on screen as it fades out, with what it said when it opened.
    expect(dialog.textContent).toContain('Delete "parent"?');
    expect(dialog.textContent).toContain("Its sub-agent stays, as a top-level agent.");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete agent" })).toBeNull());
  });

  it("deletes, refreshes the list, and says so", async () => {
    signedInAs("admin");
    const calls = answer({
      "GET /agents": [
        [200, [agent("doomed", "u1"), agent("kept", "u1")]],
        [200, [agent("kept", "u1")]],
      ],
      "DELETE /agents/doomed": [200, { ok: true, bridge_cleanup_failures: [] }],
    });
    show();

    fireEvent.click(within(await openActions("doomed")).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    // A plain success is a snackbar, not a notice on the page.
    const said = await screen.findByText('Deleted "doomed".');
    expect(said.closest(".MuiSnackbar-root")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(cards()).toEqual(["kept"]));
    expect(calls.filter((call) => call.method === "GET" && call.path === "/agents")).toHaveLength(2);
  });

  it("keeps the last list under a warning when a refresh fails", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [
        [200, [agent("doomed", "u1"), agent("kept", "u1")]],
        [503, { detail: "The database is unavailable." }],
      ],
      "DELETE /agents/doomed": [200, { ok: true, bridge_cleanup_failures: [] }],
    });
    show();

    fireEvent.click(within(await openActions("doomed")).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/Couldn't refresh the agents: The database is unavailable/)).toBeTruthy();
    expect(cards()).toEqual(["doomed", "kept"]);
  });

  it("shows devices only where agent management is on", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [200, [agent("managed", "u1", { device: { id: "d1", name: "Laptop", owner_name: "Ada", removed: false } })]],
    });
    show();
    await waitFor(() => expect(cards()).toEqual(["managed"]));
    expect(screen.queryByRole("combobox", { name: "Device" })).toBeNull();
    expect(screen.queryByText("Claude Code · Laptop")).toBeNull();
    cleanup();

    signedInAs("admin", { ...ALL_OFF, agent_management: true });
    show();
    expect(await screen.findByRole("combobox", { name: "Device" })).toBeTruthy();
    expect(screen.getByText("Claude Code · Laptop")).toBeTruthy();
  });

  it("tells apart devices that share a name by their owner, and marks a removed one", () => {
    const labels = deviceLabels([
      agent("a", "u1", { device: { id: "d1", name: "Switch Cloud", owner_name: "Ada", removed: false } }),
      // Placed on Grace's device, though Ada owns the agent: the device says whose it is.
      agent("b", "u1", { device: { id: "d2", name: "Switch Cloud", owner_name: "Grace", removed: false } }),
      agent("c", "u1", { device: { id: "d3", name: "Old laptop", owner_name: "Ada", removed: true } }),
    ]);

    expect(labels.get("d1")).toBe("Switch Cloud · Ada");
    expect(labels.get("d2")).toBe("Switch Cloud · Grace");
    expect(labels.get("d3")).toBe("Old laptop (removed)");
  });

  it("filters to top-level agents from the Parent filter", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [200, [agent("parent", "u1"), agent("child", "u1", { parent_agent_id: "parent" })]],
    });
    show();

    await waitFor(() => expect(cards()).toHaveLength(2));
    await pick("Parent", "Top level");
    await waitFor(() => expect(cards()).toEqual(["parent"]));
  });

  describe("New agent, where Switch runs agents on people's devices", () => {
    const managed = { ...ALL_OFF, agent_management: true, gateway_chats: true };
    const cloudDevice = {
      id: "box",
      name: "Switch cloud",
      description: null,
      kind: "ec2",
      platform: { os: "linux", arch: "x64", os_version: "6" },
      state: "online",
      public_key: { alg: "X25519", key: "k", key_id: "k1" },
      workspaces_dir: "/home/agents/workspaces",
      status: {
        providers: [
          { provider: "claude", installed: true, auth: "ok", version: "2", auth_source: "sealed", checked_at: "2026-11-25T08:00:00Z" },
          { provider: "codex", installed: true, auth: "missing", version: "1", auth_source: null, checked_at: "2026-11-25T08:00:00Z" },
        ],
      },
    };
    const providers = {
      providers: [
        { id: "claude", label: "Claude", advanced_fields: [] },
        { id: "codex", label: "Codex", advanced_fields: [] },
      ],
    };

    afterEach(() => providersQueryClient.clear());

    it("opens Console's dialog from the add tile, creates the agent on the person's device, and opens it", async () => {
      signedInAs("member", managed);
      const calls = answer({
        "GET /hosted-machines": [200, { available: false, machines: [] }],
        "GET /agents": [200, []],
        "GET /agents/avatar-settings": [200, { third_party_avatars_enabled: true }],
        "GET /management/controllers": [200, [cloudDevice]],
        "GET /management/providers": [200, providers],
        "POST /management/agents": [201, { agent_id: "a9", name: "helper" }],
        "PUT /agents/a9/addressing-policy": [200, {}],
      });
      render(
        <MemoryRouter initialEntries={["/agents"]}>
          <Routes>
            <Route path="/agents" element={<AgentListPage />} />
            <Route path="/chats/agents/:id" element={<p>agent page</p>} />
          </Routes>
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("New agent")).toBeTruthy();
      // A member adds no agent that runs elsewhere.
      expect(within(dialog).queryByText("Or add an agent that runs elsewhere")).toBeNull();
      expect(await within(dialog).findByText("Runs as a managed agent on Switch Cloud.")).toBeTruthy();
      expect(within(dialog).getByText("Run location")).toBeTruthy();
      // Codex is installed there but not signed in: its card gives the device a login for it.
      expect(within(dialog).getByRole("button", { name: "Give Switch Cloud a login for Codex" })).toBeTruthy();
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: /^Claude/ }).getAttribute("aria-pressed")).toBe("true"),
      );

      fireEvent.change(within(dialog).getByPlaceholderText("Name this agent"), { target: { value: "helper" } });
      fireEvent.change(within(dialog).getByPlaceholderText("What is this agent for?"), { target: { value: "Helps" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add agent" }));

      expect(await screen.findByText("agent page")).toBeTruthy();
      const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
        name: "helper",
        description: "Helps",
        controller_id: "box",
        desired_state: "running",
        definition: { provider: "claude", directory: "/home/agents/workspaces/helper", isolation: "isolated" },
      });
      expect(calls).toContainEqual({ method: "PUT", path: "/agents/a9/addressing-policy" });
    });

    it("runs the agent on the person's Switch Cloud device, claiming it, with no Run location", async () => {
      signedInAs("member", managed);
      const machine = {
        machine_id: "m1",
        state: "provisioning",
        desired_state: "running",
        stopped_by_admin: false,
        sleeping: false,
        revision: 1,
        controller_id: "box",
      };
      const calls = answer({
        "GET /hosted-machines": [200, { available: true, machines: [] }],
        "POST /hosted-machines/ensure": [200, machine],
        "GET /agents": [200, []],
        "GET /agents/avatar-settings": [200, { third_party_avatars_enabled: true }],
        "GET /management/controllers": [200, [{ ...cloudDevice, id: "laptop", kind: "console", name: "Laptop" }, cloudDevice]],
        "GET /management/providers": [200, providers],
        "POST /management/agents": [201, { agent_id: "a9", name: "helper" }],
        "PUT /agents/a9/addressing-policy": [200, {}],
      });
      render(
        <MemoryRouter initialEntries={["/agents"]}>
          <Routes>
            <Route path="/agents" element={<AgentListPage />} />
            <Route path="/chats/agents/:id" element={<p>agent page</p>} />
          </Routes>
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText("Runs on your Switch Cloud device.")).toBeTruthy();
      expect(within(dialog).queryByText("Run location")).toBeNull();
      expect(calls).toContainEqual({ method: "POST", path: "/hosted-machines/ensure" });
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: /^Claude/ }).getAttribute("aria-pressed")).toBe("true"),
      );

      fireEvent.change(within(dialog).getByPlaceholderText("Name this agent"), { target: { value: "helper" } });
      fireEvent.change(within(dialog).getByPlaceholderText("What is this agent for?"), { target: { value: "Helps" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add agent" }));

      expect(await screen.findByText("agent page")).toBeTruthy();
      const post = vi.mocked(fetch).mock.calls.find(([input, init]) => init?.method === "POST" && String(input).endsWith("/management/agents"));
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ controller_id: "box", definition: { isolation: "isolated" } });
    });

    it("closes on a click outside it, but not while the agent is being made", async () => {
      signedInAs("member", managed);
      answer({
        "GET /hosted-machines": [200, { available: false, machines: [] }],
        "GET /agents": [200, []],
        "GET /agents/avatar-settings": [200, { third_party_avatars_enabled: true }],
        "GET /management/controllers": [200, [cloudDevice]],
        "GET /management/providers": [200, providers],
      });
      const answered = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation((input, init) =>
        init?.method === "POST" ? new Promise<Response>(() => {}) : answered(input, init),
      );
      show();

      fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
      await screen.findByRole("dialog");
      clickOutsideDialog();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
      const dialog = await screen.findByRole("dialog");
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: /^Claude/ }).getAttribute("aria-pressed")).toBe("true"),
      );
      fireEvent.change(within(dialog).getByPlaceholderText("Name this agent"), { target: { value: "helper" } });
      fireEvent.change(within(dialog).getByPlaceholderText("What is this agent for?"), { target: { value: "Helps" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add agent" }));
      await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
      clickOutsideDialog();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByRole("dialog")).toBe(dialog);
    });

    it("offers an admin the dialog for an agent that runs elsewhere, from a link in it", async () => {
      signedInAs("admin", managed);
      answer({
        "GET /agents": [200, []],
        "GET /agents/known-types": [200, []],
        "GET /management/controllers": [200, []],
        "GET /management/providers": [200, providers],
      });
      show();

      fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
      fireEvent.click(await screen.findByRole("button", { name: "Or add an agent that runs elsewhere" }));
      // Console's New agent closes, and the dialog for an outside agent opens.
      await waitFor(() => expect(screen.queryByText("New agent")).toBeNull());
      expect(await screen.findByRole("heading", { name: "Add agent" })).toBeTruthy();
    });
  });
});
