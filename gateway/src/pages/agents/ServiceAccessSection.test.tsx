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

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(() => ({ isOperator: false })),
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
    render(<ServiceAccessSection agent={agent} onAgentUpdated={updated} />);
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
  });

  it("says what removing a grant does, and does not, on the agent's own machine", async () => {
    const calls = mockServer(GRANTED);
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    const remove = await screen.findByRole("button", { name: "Remove" });
    expect(remove.getAttribute("title")).toMatch(/may still use the machine's own sign-in/);

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
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
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

  it("shows nothing to someone who does not own the agent", async () => {
    mockServer(null);
    const { container } = render(
      <ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  const onOff = (
    status: ServiceConnection["status"],
    overrides: Partial<ServiceConnection> = {},
  ): ServiceConnection => ({
    slug: "example",
    name: "Example",
    category: "Project management",
    description: "Example work items.",
    enabled: true,
    connectable: true,
    unavailable_reason: null,
    server_setup_needed: false,
    status,
    pass_through: true,
    token_lifetime: 3600,
    key: null,
    ...overrides,
  });
  const NONE: ServiceGrants = { grants: [], addressing_open: false };

  it("turns a connected on/off service on with no level to choose", async () => {
    const calls = mockServer(NONE, [onOff("active")]);
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
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
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText("helper reads and writes Example as you.")).toBeTruthy();
    expect(screen.getByText(/stays valid at Example until it expires/)).toBeTruthy();
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
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    await screen.findByLabelText("Example for helper");
    expect(
      screen.getByText(
        "On, helper uses Example with your key, as far as the key allows. Turning it off stops its sessions using Example within a minute.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/stays valid/)).toBeNull();
    expect((screen.getByLabelText("Other for helper") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/To turn Other on, first connect it from Switch Console/)).toBeTruthy();
  });

  it("says why a service cannot be turned on: not connected, or not available here", async () => {
    mockServer(NONE, [
      onOff("not_connected"),
      onOff("active", {
        slug: "other",
        name: "Other",
        unavailable_reason: "Coming to this server soon.",
      }),
    ]);
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    const example = await screen.findByLabelText("Example for helper");
    expect((example as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/first connect it from Switch Console/)).toBeTruthy();
    expect(screen.getByText("Coming to this server soon.")).toBeTruthy();
    expect((screen.getByLabelText("Other for helper") as HTMLInputElement).disabled).toBe(true);
  });

  const NOT_SET_UP =
    "Example is not set up on this server. Ask whoever runs your Switch server to add it under Connectors in the Switch dashboard.";

  it("offers the operator Set up for a service waiting on its app, and nobody else", async () => {
    const services = [
      onOff("not_connected", { unavailable_reason: NOT_SET_UP, server_setup_needed: true }),
    ];
    mockServer(NONE, services);
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(NOT_SET_UP)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up" })).toBeNull();
    cleanup();

    vi.mocked(useAuth).mockReturnValue({ isOperator: true } as ReturnType<typeof useAuth>);
    mockServer(NONE, services);
    render(
      <MemoryRouter>
        <ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />
      </MemoryRouter>,
    );
    const setUp = await screen.findByRole("link", { name: "Set up" });
    expect(setUp.getAttribute("href")).toBe("/connectors");
    vi.mocked(useAuth).mockReturnValue({ isOperator: false } as ReturnType<typeof useAuth>);
  });

  it("says GitHub is not set up, rather than an error, when its App is not", async () => {
    const reason =
      "GitHub is not set up on this server. Ask whoever runs your Switch server to add it under Connectors in the Switch dashboard.";
    mockServer(NONE, [
      onOff("not_connected", {
        slug: "github",
        name: "GitHub",
        pass_through: false,
        unavailable_reason: reason,
        server_setup_needed: true,
      }),
    ]);
    render(<ServiceAccessSection agent={agent} onAgentUpdated={vi.fn()} />);
    expect(await screen.findByText(reason)).toBeTruthy();
  });
});
