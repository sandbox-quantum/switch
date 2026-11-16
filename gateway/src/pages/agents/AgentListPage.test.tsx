import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentListEntry, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import { ALL_OFF, type FeatureFlags } from "../../data/featureFlags";
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

  it("shows an admin every agent in the workspace, with an Owner filter", async () => {
    signedInAs("admin");
    answer({ "GET /agents": [200, [agent("mine", "u1"), agent("theirs", "u2")]] });
    show();

    expect(await screen.findByText("2 agents")).toBeTruthy();
    expect(screen.getByText("Agents in Acme.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Owner" })).toBeTruthy();
  });

  it("shows a member only their own agents, and says so", async () => {
    signedInAs("member");
    answer({ "GET /agents": [200, [agent("mine", "u1"), agent("theirs", "u2")]] });
    show();

    expect(await screen.findByText("1 agent")).toBeTruthy();
    expect(screen.getByText("The agents you own in Acme.")).toBeTruthy();
    // One owner to pick from is no filter at all.
    expect(screen.queryByRole("combobox", { name: "Owner" })).toBeNull();
  });

  it("tells anyone in an empty workspace that it has no agents yet", async () => {
    signedInAs("member");
    answer({ "GET /agents": [200, []] });
    show();

    expect(await screen.findByText("No agents in Acme yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add agent" })).toHaveLength(2);
    // Nothing to filter or search: the card stands in for the table.
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
    expect(screen.queryByLabelText("Search agents")).toBeNull();
  });

  it("tells a member who owns none of the workspace's agents that they own none", async () => {
    signedInAs("member");
    answer({ "GET /agents": [200, [agent("theirs", "u2")]] });
    show();

    expect(await screen.findByText("You don't own any agents in Acme")).toBeTruthy();
  });

  it("says why the list could not load, rather than show an empty one", async () => {
    signedInAs("admin");
    answer({ "GET /agents": [503, { detail: "The database is unavailable." }] });
    show();

    expect(await screen.findByText(/Couldn't load the agents: The database is unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/No agents in Acme/)).toBeNull();
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

    fireEvent.click(await screen.findByRole("button", { name: "Actions for managed" }));
    const menu = await screen.findByRole("menu");
    const transfer = within(menu).getByRole("menuitem", { name: /Transfer ownership/ });
    expect(transfer.getAttribute("aria-disabled")).toBe("true");
    expect(within(transfer).getByText(/can't be transferred/)).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Rename/ })).toBeNull();
  });

  it("keeps the delete dialog open with the server's reason when the delete is refused", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [200, [agent("parent", "u1"), agent("child", "u1", { parent_agent_id: "parent" })]],
      "DELETE /agents/parent": [403, { detail: "Only the agent's owner or an admin can delete it." }],
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Actions for parent" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Actions for gone" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Agent not found: gone")).toBeTruthy();
    expect(await screen.findByText("1 agent")).toBeTruthy();
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

    fireEvent.click(await screen.findByRole("button", { name: "Actions for parent" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByText('Deleted "parent".');
    await screen.findByText("1 agent");

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

    fireEvent.click(await screen.findByRole("button", { name: "Actions for doomed" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText('Deleted "doomed".')).toBeTruthy();
    expect(await screen.findByText("1 agent")).toBeTruthy();
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

    fireEvent.click(await screen.findByRole("button", { name: "Actions for doomed" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/Couldn't refresh the agents: The database is unavailable/)).toBeTruthy();
    expect(screen.getByText("2 agents")).toBeTruthy();
  });

  it("shows devices only where agent management is on", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [200, [agent("managed", "u1", { device: { id: "d1", name: "Laptop", owner_name: "Ada", removed: false } })]],
    });
    show();
    expect(await screen.findByText("1 agent")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Device" })).toBeNull();
    cleanup();

    signedInAs("admin", { ...ALL_OFF, agent_management: true });
    show();
    expect(await screen.findByRole("combobox", { name: "Device" })).toBeTruthy();
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

  it("filters to top-level agents from the Parent dropdown", async () => {
    signedInAs("admin");
    answer({
      "GET /agents": [200, [agent("parent", "u1"), agent("child", "u1", { parent_agent_id: "parent" })]],
    });
    show();

    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Parent" }));
    fireEvent.click(await screen.findByRole("option", { name: "Top level" }));

    await waitFor(() => expect(screen.getByText("1 of 2 agents")).toBeTruthy());
  });
});
