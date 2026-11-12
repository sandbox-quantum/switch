import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ServiceAgent,
  ServiceConnection,
  ServiceGrant,
  ServiceInWorkspace,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { serviceConnection } from "../../test/serviceConnection";
import ConnectorPage from "./ConnectorPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

function signedIn({ admin = false, orgAdmin = false } = {}) {
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "me", name: "Ada", email: "ada@example.test", is_operator: false },
      tenant: { id: "t1", slug: "acme", name: "Acme", role: admin ? "admin" : "member", organization_role: orgAdmin ? "org_admin" : null, organization_id: "o1" },
    },
    capabilities: {
      administersWorkspace: admin,
      administersOrganization: orgAdmin,
      features: { gateway_v2: true },
    },
    isOperator: false,
  } as unknown as ReturnType<typeof useAuth>);
}

const grant = (overrides: Partial<ServiceGrant> = {}): ServiceGrant => ({
  service: "example",
  name: "Example",
  access: "write",
  tool_mode: "deny",
  tools: [],
  effective_tools: [],
  resources: {},
  summary: "builder can read and write Example.",
  ...overrides,
});

const agent = (overrides: Partial<ServiceAgent> = {}): ServiceAgent => ({
  agent_id: "a1",
  name: "builder",
  granted: false,
  grant: null,
  grantable: true,
  addressing_open: false,
  ...overrides,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function answer(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${path}`;
      if (!(key in routes))
        return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 404 });
      return new Response(JSON.stringify(routes[key]), { status: 200 });
    }),
  );
  return calls;
}

function server(
  connection: ServiceConnection,
  agents: ServiceAgent[] = [],
  workspace: ServiceInWorkspace | null = null,
  extra: Record<string, unknown> = {},
) {
  return answer({
    "GET /service-connections": { connections: [connection] },
    [`GET /service-connections/${connection.slug}/agents`]: agents,
    ...(workspace ? { [`GET /service-connections/${connection.slug}/workspace`]: workspace } : {}),
    ...extra,
  });
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function renderPage(slug = "example", state: unknown = null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/connectors/${slug}`, state }]}>
      <Routes>
        <Route path="/connectors/:connectorId" element={<ConnectorPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("a connector's page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says who you are connected as, and the facts about the connector", async () => {
    signedIn();
    server(
      serviceConnection({
        status: "active",
        consent: "write",
        external_identity: "ada-example",
        can_revoke: true,
      }),
    );
    renderPage();

    expect(await screen.findByText("Connected as ada-example · Read and write")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    const general = screen.getByRole("region", { name: "General" });
    expect(within(general).getByText("Sign in at Example")).toBeTruthy();
    expect(within(general).getByText("1 hour")).toBeTruthy();
    expect(within(general).getByRole("link", { name: /Privacy policy/ })).toHaveProperty(
      "href",
      "https://example.test/privacy",
    );
    expect(within(general).getByText("https://mcp.example.test/mcp")).toBeTruthy();
  });

  it("sends a sign-in to Switch Console, where it can finish", async () => {
    signedIn();
    server(serviceConnection());
    renderPage();

    expect(await screen.findByText("Connect from Switch Console")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("takes a key here, checked before it is stored", async () => {
    signedIn();
    const calls = server(
      serviceConnection({
        slug: "datadog",
        name: "Datadog",
        auth_type: "api_key",
        key: {
          fields: [
            { name: "api_key", label: "API key", secret: true, help: null, choices: null },
            { name: "site", label: "Site", secret: false, help: null, choices: ["datadoghq.com", "datadoghq.eu"] },
          ],
          help_url: null,
        },
      }),
      [],
      null,
      { "PUT /service-connections/datadog/key": { warning: null, external_identity: "org-1" } },
    );
    renderPage("datadog");

    fireEvent.click(await screen.findByRole("button", { name: "Add keys" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "dd-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add keys" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/service-connections/datadog/key",
        body: { fields: { api_key: "dd-key", site: "datadoghq.com" } },
      }),
    );
  });

  it("says the organization turned it off, and only its admins can change that", async () => {
    signedIn({ admin: true, orgAdmin: true });
    server(
      serviceConnection({ workspace_enabled: false, organization_locked: true, decided_by: "organization" }),
      [],
      { people: [], agents: [] },
    );
    renderPage();

    expect(
      await screen.findByText(/Switched off in Acme by your organization, for every workspace/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Organization settings" })).toHaveProperty(
      "pathname",
      "/settings/org/connectors",
    );
    expect(screen.queryByText("Connect from Switch Console")).toBeNull();
  });

  it("says a workspace admin turned it off, and who can turn it back on", async () => {
    signedIn();
    server(serviceConnection({ workspace_enabled: false, decided_by: "workspace" }));
    renderPage();

    expect(
      await screen.findByText(/Switched off in Acme by a workspace admin.*A workspace admin can turn it on/),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Workspace settings" })).toBeNull();
  });

  it("shows a member their own agents, and adds one", async () => {
    signedIn();
    const calls = server(
      serviceConnection({ status: "active", consent: "write", can_revoke: true }),
      [
        agent({ agent_id: "a1", name: "builder", granted: true, grant: grant() }),
        agent({ agent_id: "a2", name: "planner" }),
        agent({ agent_id: "a3", name: "standalone", grantable: false }),
      ],
      null,
      { "PUT /agents/a2/service-grants/example": { grant: grant(), warning: null } },
    );
    renderPage();

    const card = await screen.findByTestId("connector-agent-a1");
    expect(within(card).getByText("On")).toBeTruthy();
    expect(within(card).getByText("builder can read and write Example.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.mouseDown(within(dialog).getByLabelText("Your agent"));
    // An agent on its own runtime can't be granted a connector, so isn't offered.
    expect(screen.queryByRole("option", { name: "standalone" })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: "planner" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/agents/a2/service-grants/example",
        body: { resources: {} },
      }),
    );
  });

  it("adds an agent to GitHub on the repositories picked, and names them on its card", async () => {
    signedIn();
    const github = {
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
    const calls = server(
      serviceConnection({
        slug: "github",
        name: "GitHub",
        pass_through: false,
        status: "active",
        consent: "write",
        can_revoke: true,
      }),
      [
        agent({
          agent_id: "a1",
          name: "builder",
          granted: true,
          grant: grant({ service: "github", access: "read", resources: { installation_id: 7, repository_ids: [70] } }),
        }),
        agent({ agent_id: "a2", name: "planner" }),
      ],
      null,
      {
        "GET /provider-connections/github": github,
        "PUT /agents/a2/service-grants/github": { grant: grant(), warning: null },
      },
    );
    renderPage("github");

    const card = await screen.findByTestId("connector-agent-a1");
    expect(within(card).getByText("Read")).toBeTruthy();
    expect(await within(card).findByText("example-org/project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.mouseDown(within(dialog).getByLabelText("Your agent"));
    fireEvent.click(await screen.findByRole("option", { name: "planner" }));
    fireEvent.mouseDown(within(dialog).getByLabelText("GitHub account"));
    fireEvent.click(await screen.findByRole("option", { name: "example-org" }));
    fireEvent.mouseDown(within(dialog).getByLabelText("Repositories"));
    fireEvent.click(await screen.findByRole("option", { name: "example-org/docs" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Grant" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/agents/a2/service-grants/github",
        body: { access: "read", resources: { installation_id: 7, repository_ids: [71] } },
      }),
    );
  });

  it("shows an admin every agent and everyone else connected, and revokes one", async () => {
    signedIn({ admin: true });
    const calls = server(
      serviceConnection({ status: "active", consent: "write", can_revoke: true }),
      [],
      {
        people: [
          { user_id: "me", name: "Ada", status: "active", connected_at: "2026-11-01T09:00:00Z", agents: 0, can_revoke: false },
          { user_id: "u2", name: "Bob", status: "active", connected_at: "2026-11-03T09:00:00Z", agents: 2, can_revoke: true },
        ],
        agents: [
          { agent_id: "b1", name: "bobs-agent", owner_id: "u2", owner_name: "Bob", grant: grant(), addressing_open: true },
        ],
      },
      { "DELETE /service-connections/example/people/u2": { warning: null } },
    );
    renderPage();

    const card = await screen.findByTestId("connector-agent-b1");
    expect(within(card).getByText("Bob")).toBeTruthy();
    // Others can have Bob's agent act as Bob: the admin is told, in Bob's name.
    expect(within(card).getByText("Others can address it; it would act as Bob.")).toBeTruthy();
    // Nobody grants on someone else's connector, admins included.
    expect(within(card).queryByRole("button", { name: "Remove" })).toBeNull();
    const people = screen.getByRole("region", { name: "Connected in Acme" });
    expect(within(people).queryByText("Ada")).toBeNull();
    const bob = within(people).getByTestId("connected-u2");
    expect(within(bob).getByText("Connected 2026-11-03 · 2 agents using it")).toBeTruthy();
    fireEvent.click(within(bob).getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Revoke Bob's Example access?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
        "DELETE /service-connections/example/people/u2",
      ),
    );
  });

  it("counts the repositories of someone else's GitHub grant rather than listing their numbers", async () => {
    signedIn({ admin: true });
    server(
      serviceConnection({ slug: "github", name: "GitHub", pass_through: false }),
      [],
      {
        people: [],
        agents: [
          {
            agent_id: "b1",
            name: "bobs-agent",
            owner_id: "u2",
            owner_name: "Bob",
            grant: grant({ service: "github", resources: { installation_id: 9, repository_ids: [90, 91] } }),
            addressing_open: false,
          },
        ],
      },
    );
    renderPage("github");

    const card = await screen.findByTestId("connector-agent-b1");
    expect(within(card).getByText("Bob · 2 repositories")).toBeTruthy();
    expect(within(card).queryByText(/repository 90/)).toBeNull();
  });

  it("says the lists failed to load rather than that nobody uses it", async () => {
    signedIn({ admin: true });
    answer({
      "GET /service-connections": { connections: [serviceConnection({ status: "active", consent: "write" })] },
      "GET /service-connections/example/agents": [],
    });
    renderPage();

    expect(await screen.findByText("unmocked GET /service-connections/example/workspace")).toBeTruthy();
    expect(screen.queryByText(/uses Example yet/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Connected in Acme" })).toBeNull();
  });

  it("disconnects after asking", async () => {
    signedIn();
    const calls = server(
      serviceConnection({ status: "active", consent: "read", can_revoke: true }),
      [],
      null,
      { "DELETE /service-connections/example": { warning: null } },
    );
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /service-connections/example"),
    );
  });

  it("goes back to the page that opened it", async () => {
    signedIn();
    server(serviceConnection());
    renderPage("example", { back: { label: "Connectors and apps", to: "/settings/org/connectors" } });

    fireEvent.click(await screen.findByRole("button", { name: "Connectors and apps" }));

    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/settings/org/connectors"),
    );
  });

  it("says when there is no such connector", async () => {
    signedIn();
    server(serviceConnection());
    renderPage("nowhere");

    expect(await screen.findByText("There is no connector named nowhere.")).toBeTruthy();
  });
});
