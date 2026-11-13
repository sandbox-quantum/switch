import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDetail,
  OWNER_ONLY_POLICY,
  type ServiceConnection,
  type ServiceGrants,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import ServiceAccessSection from "./ServiceAccessSection";
import { serviceConnection } from "../../test/serviceConnection";

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(() => ({ isOperator: false, capabilities: { features: { gateway_v2: false } } })),
}));

const agent: AgentDetail = {
  id: "a1",
  name: "helper",
  display_name: null,
  description: "Helps",
  connector_type: "claude_code",
  connection_model: "auto_session",
  tool_count: 0,
  model_count: 0,
  owner_id: "u1",
  owner_name: "ada",
  oauth_client_id: null,
  created_at: "2026-10-01T00:00:00Z",
  parent_agent_id: null,
  known_agent_type: "claude-code",
  known_agent_options: null,
  agent_type: "auto_session",
  integration_profile: {},
  tools: [],
  models: [],
  rooms: [],
  sessions: [],
  children: [],
  addressing_policy: null,
  can_manage_agents: false,
  can_manage: true,
  can_rename: true,
  can_edit_options: true,
  can_transfer: true,
  transfer_blocked_reason: null,
  can_change_manage_agents: true,
  can_grant_services: true,
};

const GITHUB = {
  status: "connected",
  login: "ada-gh",
  install_url: "https://github.com/apps/example/installations/new",
  installations: [
    {
      id: 7,
      account: "example-org",
      repositories: [
        { id: 70, name: "example-org/project" },
        { id: 71, name: "example-org/docs" },
      ],
    },
  ],
};

type Call = { path: string; method: string; body: unknown };

function mockServer(grants: ServiceGrants | null, services: ServiceConnection[] = []) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status });
      if (path === "/gateway/agents/a1/service-grants")
        return grants ? json(grants) : json({ detail: "Agent not found." }, 404);
      if (path === "/gateway/provider-connections/github") return json(GITHUB);
      if (path === "/gateway/service-connections") return json({ connections: services });
      if (path === "/gateway/agents/a1/service-grants/example" && method === "PUT")
        return json({ grant: {}, warning: null });
      if (path === "/gateway/agents/a1/service-grants/example" && method === "DELETE")
        return json({ warning: null });
      if (path === "/gateway/agents/a1/service-grants/github" && method === "PUT")
        return json({ grant: {}, warning: null });
      if (path === "/gateway/agents/a1/service-grants/github" && method === "DELETE")
        return json({ warning: null });
      if (path === "/gateway/agents/a1/addressing-policy") return json(agent);
      return json({ detail: "Not Found" }, 404);
    }),
  );
  return calls;
}

const GRANTED: ServiceGrants = {
  grants: [
    {
      service: "github",
      name: "GitHub",
      access: "write",
      tool_mode: "deny",
      tools: [],
      effective_tools: [],
      resources: { installation_id: 7, repository_ids: [70] },
      summary: "helper can read and push to 1 repository, acting as the GitHub App.",
    },
  ],
  addressing_open: true,
};

describe("ServiceAccessSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each grant with its repositories, and offers owner-only when anyone can address the agent", async () => {
    const calls = mockServer(GRANTED);
    const updated = vi.fn();
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={updated} />);
    expect(await screen.findByText(GRANTED.grants[0]!.summary)).toBeTruthy();
    expect(await screen.findByText("example-org/project")).toBeTruthy();
    expect(screen.getByText(/show as the Switch GitHub App/)).toBeTruthy();
    expect(screen.getByText(/Not available on Windows yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Make owner-only" }));
    await waitFor(() => expect(updated).toHaveBeenCalled());
    expect(calls).toContainEqual({
      path: "/gateway/agents/a1/addressing-policy",
      method: "PUT",
      body: { policy: OWNER_ONLY_POLICY },
    });
    // The owner alone, as Switch Console asks for it.
    expect(OWNER_ONLY_POLICY.rules).toEqual([
      expect.objectContaining({ owner: true, owner_agents: false, users: [], agents: [] }),
    ]);
  });

  it("says what removing a grant does, and does not, on the agent's own machine", async () => {
    const calls = mockServer(GRANTED);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    const remove = await screen.findByRole("button", { name: "Remove" });
    expect(remove.getAttribute("title")).toMatch(/may still use the device's own sign-in/);

    fireEvent.click(remove);
    expect(await screen.findByText(/Removing a grant stops Switch giving this access/)).toBeTruthy();
    expect(calls).toContainEqual({
      path: "/gateway/agents/a1/service-grants/github",
      method: "DELETE",
      body: null,
    });
  });

  it("grants GitHub on the repositories picked, for reading unless asked", async () => {
    const calls = mockServer({ grants: [], addressing_open: false });
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    const account = await screen.findByLabelText("GitHub account");
    fireEvent.mouseDown(account);
    fireEvent.click(await screen.findByText("example-org"));
    fireEvent.mouseDown(screen.getByLabelText("Repositories"));
    fireEvent.click(await screen.findByText("example-org/docs"));
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/gateway/agents/a1/service-grants/github",
        method: "PUT",
        body: { access: "read", resources: { installation_id: 7, repository_ids: [71] } },
      }),
    );
  });

  it("shows nothing to someone who does not own the agent, and reads none of their own connections", async () => {
    const calls = mockServer(null);
    const { container } = render(
      <ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(calls.map((c) => c.path)).toEqual(["/gateway/agents/a1/service-grants"]);
  });

  const onOff = (
    status: ServiceConnection["status"],
    overrides: Partial<ServiceConnection> = {},
  ): ServiceConnection => serviceConnection({ status, ...overrides });
  const NONE: ServiceGrants = { grants: [], addressing_open: false };

  it("turns a connected on/off service on with no level to choose", async () => {
    const calls = mockServer(NONE, [onOff("active")]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    const toggle = await screen.findByLabelText("Example for helper");
    expect(screen.getByText(/helper acts as you at Example/)).toBeTruthy();
    expect(screen.getByText(/within a minute/)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/gateway/agents/a1/service-grants/example",
        method: "PUT",
        body: { resources: {} },
      }),
    );
  });

  it("turns an on/off grant off, and says a longer-lived token outlasts it", async () => {
    const calls = mockServer(
      {
        grants: [
          {
            service: "example",
            name: "Example",
            access: "write",
            tool_mode: "deny",
            tools: [],
            effective_tools: [],
            resources: {},
            summary: "helper reads and writes Example as you.",
          },
        ],
        addressing_open: false,
      },
      [onOff("active", { token_lifetime: 24 * 3600 })],
    );
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText("helper reads and writes Example as you.")).toBeTruthy();
    expect(
      screen.getByText(
        /may keep working at Example until it expires, up to 24 hours after it was handed out\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/you disconnect/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Example for helper"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/gateway/agents/a1/service-grants/example",
        method: "DELETE",
        body: null,
      }),
    );
  });

  it("says a key service is used with the owner's key, and to connect it from Switch Console", async () => {
    const key = {
      fields: [{ name: "api_key", label: "API key", secret: true, help: null, choices: null }],
      help_url: null,
    };
    mockServer(NONE, [
      onOff("active", { key, token_lifetime: 24 * 3600 }),
      onOff("not_connected", { slug: "other", name: "Other", key }),
    ]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    await screen.findByLabelText("Example for helper");
    expect(
      screen.getByText(
        "On, helper uses Example with your key, as far as the key allows. Turning it off stops its sessions using Example within a minute.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/stays valid/)).toBeNull();
    expect((screen.getByLabelText("Other for helper") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/To turn Other on, first connect it in Switch Console/)).toBeTruthy();
  });

  it("says why a service cannot be turned on: not connected, or not available here", async () => {
    mockServer(NONE, [
      onOff("not_connected"),
      onOff("active", {
        slug: "other",
        name: "Other",
        unavailable_reason: "Coming here soon.",
      }),
    ]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    const example = await screen.findByLabelText("Example for helper");
    expect((example as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/first connect it in Switch Console/)).toBeTruthy();
    expect(screen.getByText("Coming here soon.")).toBeTruthy();
    expect((screen.getByLabelText("Other for helper") as HTMLInputElement).disabled).toBe(true);
  });

  it("says a service signs in through the organization's app only while that app works", async () => {
    const through = "Signs in through your organization's Example app.";
    mockServer(NONE, [onOff("active", { app_source: "organization" })]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(through)).toBeTruthy();
    cleanup();

    const broken = "Your organization's Example app can't be used: it is broken.";
    mockServer(NONE, [
      onOff("active", { app_source: "organization", unavailable_reason: broken }),
    ]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(broken)).toBeTruthy();
    expect(screen.queryByText(through)).toBeNull();
  });

  const SWITCHED_OFF = (name: string) =>
    `${name} is not enabled in this workspace. Ask a workspace admin; they switch it on under Connectors in Switch Console.`;

  it("says a service switched off in the workspace cannot be turned on, and still turns one off", async () => {
    const calls = mockServer(
      {
        grants: [
          {
            service: "example",
            name: "Example",
            access: "read",
            tool_mode: "allow",
            tools: [],
            effective_tools: [],
            resources: {},
            summary: "helper reads Example as you.",
          },
        ],
        addressing_open: false,
      },
      [
        onOff("active", { workspace_enabled: false }),
        onOff("active", { slug: "other", name: "Other", workspace_enabled: false }),
      ],
    );
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    const other = await screen.findByLabelText("Other for helper");
    expect((other as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(SWITCHED_OFF("Other"))).toBeTruthy();
    // On, it does nothing until the workspace switches it back on; it can be turned off.
    expect(screen.getByText(SWITCHED_OFF("Example"))).toBeTruthy();
    const example = screen.getByLabelText("Example for helper") as HTMLInputElement;
    expect(example.disabled).toBe(false);
    fireEvent.click(example);
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/gateway/agents/a1/service-grants/example",
        method: "DELETE",
        body: null,
      }),
    );
  });

  it("says GitHub is switched off in the workspace instead of offering to grant it", async () => {
    mockServer(NONE, [
      onOff("active", {
        slug: "github",
        name: "GitHub",
        pass_through: false,
        workspace_enabled: false,
      }),
    ]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(SWITCHED_OFF("GitHub"))).toBeTruthy();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  });

  it("offers no Change on a GitHub grant the workspace cannot use, and still removes it", async () => {
    mockServer(GRANTED, [
      onOff("active", {
        slug: "github",
        name: "GitHub",
        pass_through: false,
        workspace_enabled: false,
      }),
    ]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(SWITCHED_OFF("GitHub"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  const NOT_SET_UP =
    "Example is not set up here. Whoever runs Switch can set it up in Switch Console, under Admin → Connector apps.";

  it("offers the operator Set up for a service waiting on its app, and nobody else", async () => {
    const services = [
      onOff("not_connected", { unavailable_reason: NOT_SET_UP, server_setup_needed: true }),
    ];
    mockServer(NONE, services);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(NOT_SET_UP)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up" })).toBeNull();
    cleanup();

    for (const [newLayout, where] of [
      [false, "/connectors"],
      [true, "/platform/connectors"],
    ] as const) {
      vi.mocked(useAuth).mockReturnValue({
        isOperator: true,
        capabilities: { features: { gateway_v2: newLayout } },
      } as ReturnType<typeof useAuth>);
      mockServer(NONE, services);
      render(
        <MemoryRouter>
          <ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />
        </MemoryRouter>,
      );
      const setUp = await screen.findByRole("link", { name: "Set up" });
      expect(setUp.getAttribute("href")).toBe(where);
      cleanup();
    }
    vi.mocked(useAuth).mockReturnValue({
      isOperator: false,
      capabilities: { features: { gateway_v2: false } },
    } as ReturnType<typeof useAuth>);
  });

  it("keeps what an agent was granted removable where it may be granted nothing more", async () => {
    mockServer(GRANTED, [onOff("active")]);
    render(<ServiceAccessSection agent={agent} canGrant={false} onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(GRANTED.grants[0]!.summary)).toBeTruthy();
    expect(screen.getByText(/New grants are only for an agent Switch Console runs/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
    expect(screen.getByRole("switch", { name: /for helper/ })).toHaveProperty("disabled", true);
  });

  it("says GitHub is not set up, rather than an error, when its App is not, and asks for no connection", async () => {
    const reason =
      "GitHub is not set up here. Whoever runs Switch can set it up in Switch Console, under Admin → Connector apps.";
    const calls = mockServer(NONE, [
      onOff("not_connected", {
        slug: "github",
        name: "GitHub",
        pass_through: false,
        unavailable_reason: reason,
        server_setup_needed: true,
      }),
    ]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(calls.map((call) => call.path)).not.toContain("/gateway/provider-connections/github");
  });

  /** Answer `path` with `answer` instead of what `mockServer` would. */
  function answerInstead(path: string, answer: () => Response) {
    const server = vi.mocked(fetch);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === path ? answer() : server(input, init),
      ),
    );
  }

  it("still asks for GitHub when the services cannot be read", async () => {
    const calls = mockServer(NONE);
    answerInstead(
      "/gateway/service-connections",
      () => new Response(JSON.stringify({ detail: "The database is unavailable" }), { status: 500 }),
    );
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByLabelText("GitHub account")).toBeTruthy();
    expect(calls.map((call) => call.path)).toContain("/gateway/provider-connections/github");
  });

  it("says why GitHub cannot be used where the organization's own App is broken", async () => {
    const problem = "The organization's GitHub App no longer works. An organization admin can set it up again.";
    mockServer(NONE, [
      onOff("not_connected", {
        slug: "github",
        name: "GitHub",
        pass_through: false,
        unavailable_reason: problem,
        server_setup_needed: false,
        app_source: "organization",
      }),
    ]);
    answerInstead(
      "/gateway/provider-connections/github",
      () => new Response(JSON.stringify({ detail: problem }), { status: 503 }),
    );
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    // Said once, where the GitHub form would be, in place of the form.
    expect(await screen.findByText(problem)).toBeTruthy();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  const READ_ONLY =
    "Switch's GitHub App lets agents read only, so GitHub can't be granted for writing. Whoever runs Switch can change that in Switch Console, under Admin → Connector apps.";
  const readOnlyGitHub = onOff("active", {
    slug: "github",
    name: "GitHub",
    pass_through: false,
    read_only_reason: READ_ONLY,
  });

  it("offers GitHub for reading only where the server's App can't write, saying why", async () => {
    const calls = mockServer(NONE, [readOnlyGitHub]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    await screen.findByLabelText("GitHub account");
    expect(screen.getByText(READ_ONLY)).toBeTruthy();
    const push = screen.getByLabelText("Read and push") as HTMLInputElement;
    expect(push.disabled).toBe(true);
    expect((screen.getByLabelText("Read") as HTMLInputElement).disabled).toBe(false);
    fireEvent.mouseDown(screen.getByLabelText("GitHub account"));
    fireEvent.click(await screen.findByText("example-org"));
    fireEvent.mouseDown(screen.getByLabelText("Repositories"));
    fireEvent.click(await screen.findByText("example-org/docs"));
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/gateway/agents/a1/service-grants/github",
        method: "PUT",
        body: { access: "read", resources: { installation_id: 7, repository_ids: [71] } },
      }),
    );
  });

  it("says why a write grant made before gets nothing on such a server", async () => {
    mockServer(GRANTED, [readOnlyGitHub]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(GRANTED.grants[0]!.summary)).toBeTruthy();
    expect(await screen.findByText(READ_ONLY)).toBeTruthy();
  });

  it("says nothing of it where the App can write", async () => {
    mockServer(GRANTED, [{ ...readOnlyGitHub, read_only_reason: null }]);
    render(<ServiceAccessSection agent={agent} canGrant onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(GRANTED.grants[0]!.summary)).toBeTruthy();
    expect(screen.queryByText(READ_ONLY)).toBeNull();
  });
});
