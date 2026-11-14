import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ServiceAgent,
  ServiceConnection,
  ServiceGrant,
  ServiceInWorkspace,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { pastedConnector, serviceConnection } from "../../test/serviceConnection";
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

/** A reply other than 200, for the routes that need one. */
class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
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
      const reply = routes[key];
      if (reply instanceof Reply) return new Response(JSON.stringify(reply.body), { status: reply.status });
      return new Response(JSON.stringify(reply), { status: 200 });
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

function Query() {
  return <output data-testid="query">{useLocation().search}</output>;
}

function renderPage(slug = "example", state: unknown = null, search = "") {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/connectors/${slug}`, search, state }]}>
      <Routes>
        <Route
          path="/connectors/:connectorId"
          element={
            <>
              <ConnectorPage />
              <Query />
            </>
          }
        />
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
      serviceConnection({ workspace_enabled: false, organization_locked: true, decided_by: "organization_locked" }),
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

  it("says a pasted token keeps working after disconnecting, and shows why it was not revoked", async () => {
    signedIn();
    const calls = server(
      pastedConnector({
        status: "active",
        can_revoke: true,
        method: "token",
        choices: { site: "datadoghq.eu" },
        external_identity: "ada@example.test",
      }),
      [],
      null,
      {
        "DELETE /service-connections/datadog": {
          warning: "Switch has forgotten the pasted Datadog token but cannot revoke it.",
        },
      },
    );
    renderPage("datadog");

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Switch forgets your personal access token but cannot revoke it/),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/what was handed out to them is revoked/)).toBeNull();
    expect(within(dialog).getByRole("link", { name: "How to delete it" }).getAttribute("href")).toBe(
      "https://docs.example.test/tokens",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /service-connections/datadog"),
    );
    expect(await screen.findByText("Switch has forgotten the pasted Datadog token but cannot revoke it.")).toBeTruthy();
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

describe("connecting from a connector's page", () => {
  const originalLocation = window.location;
  const assign = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalLocation, assign } });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    assign.mockClear();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: originalLocation });
  });

  it("leaves for a sign-in that comes back here", async () => {
    signedIn();
    const calls = server(serviceConnection({ web_sign_in: true }), [], null, {
      "POST /service-connections/example/flows/web": { id: "flow-1", url: "https://switch.example.test/authorize?state=flow-1" },
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://switch.example.test/authorize?state=flow-1"));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("POST /service-connections/example/flows/web");
    expect(screen.queryByText("Connect from Switch Console")).toBeNull();
  });

  it("signs in to GitHub through its own App's flow", async () => {
    signedIn();
    const calls = server(serviceConnection({ slug: "github", name: "GitHub", web_sign_in: true }), [], null, {
      "POST /provider-connections/github/flows/web": { id: "flow-2", url: "https://switch.example.test/gh?state=flow-2" },
    });
    renderPage("github");

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://switch.example.test/gh?state=flow-2"));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("POST /provider-connections/github/flows/web");
  });

  it("offers a fresh sign-in when the connection needs one", async () => {
    signedIn();
    server(serviceConnection({ web_sign_in: true, status: "needs_reauthorization", can_revoke: true }), [], null, {
      "POST /service-connections/example/flows/web": { id: "flow-9", url: "https://switch.example.test/authorize?state=flow-9" },
    });
    renderPage();

    expect(await screen.findByText("It needs a fresh sign-in before agents can use it again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://switch.example.test/authorize?state=flow-9"));
  });

  it("says it connected on the way back, then forgets the sign-in", async () => {
    signedIn();
    const calls = server(serviceConnection({ web_sign_in: true }), [], null, {
      "GET /service-connections/example/flows/flow-1": {
        status: "connected",
        account: "ada@example.test",
        error: null,
        warning: null,
      },
      "DELETE /service-connections/example/flows/flow-1": {},
    });
    renderPage("example", null, "?sign_in=flow-1");

    expect(await screen.findByText("Connected to Example as ada@example.test.")).toBeTruthy();
    await waitFor(() =>
      expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
        "DELETE /service-connections/example/flows/flow-1",
      ),
    );
    await waitFor(() => expect(screen.getByTestId("query").textContent).toBe(""));
  });

  it("says why a sign-in failed on the way back", async () => {
    signedIn();
    server(serviceConnection({ web_sign_in: true }), [], null, {
      "GET /service-connections/example/flows/flow-1": {
        status: "failed",
        account: null,
        error: "This Example account is already linked to another Switch user in this workspace. Remove that link first.",
        warning: null,
      },
      "DELETE /service-connections/example/flows/flow-1": {},
    });
    renderPage("example", null, "?sign_in=flow-1");

    expect(await screen.findByText(/already linked to another Switch user/)).toBeTruthy();
  });

  it("says a sign-in that never came back didn't finish, and one that expired has", async () => {
    signedIn();
    server(serviceConnection({ web_sign_in: true }), [], null, {
      "GET /service-connections/example/flows/flow-1": { status: "pending", account: null, error: null, warning: null },
      "DELETE /service-connections/example/flows/flow-1": {},
    });
    renderPage("example", null, "?sign_in=flow-1");
    expect(await screen.findByText("The Example sign-in didn't finish. Connect again.")).toBeTruthy();

    cleanup();
    server(serviceConnection({ web_sign_in: true }), [], null, {
      "GET /service-connections/example/flows/flow-2": new Reply(410, { detail: "Sign-in was interrupted." }),
    });
    renderPage("example", null, "?sign_in=flow-2");
    expect(await screen.findByText("That Example sign-in has expired. Connect again.")).toBeTruthy();
  });

  it("reads GitHub's outcome from its own flow", async () => {
    signedIn();
    server(serviceConnection({ slug: "github", name: "GitHub", web_sign_in: true }), [], null, {
      "GET /provider-connections/github/flows/flow-3": { status: "connected", login: "octocat", error: null, warning: null },
      "DELETE /provider-connections/github/flows/flow-3": {},
    });
    renderPage("github", null, "?sign_in=flow-3");

    expect(await screen.findByText("Connected to GitHub as octocat.")).toBeTruthy();
  });
});

describe("connecting by pasting a token in place of a sign-in", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("picks the site and pastes a token, checked before it is stored", async () => {
    signedIn();
    const calls = server(pastedConnector(), [], null, {
      "PUT /service-connections/datadog/paste": { warning: null, external_identity: "ada@example.test" },
    });
    renderPage("datadog");

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(screen.queryByText("Connect from Switch Console")).toBeNull();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/To sign in with your account instead, connect it from Switch Console/)).toBeTruthy();
    expect(within(dialog).getByText(/Expires on the date you set in Datadog\. Reaches what your token allows\./)).toBeTruthy();
    fireEvent.mouseDown(within(dialog).getByRole("combobox", { name: "Datadog site" }));
    fireEvent.click(await screen.findByRole("option", { name: "datadoghq.eu" }));
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Personal access token"), { target: { value: " ddpat_example " } });
    fireEvent.click(connect);

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/service-connections/datadog/paste",
        body: { method: "token", fields: { pat: "ddpat_example" }, choices: { site: "datadoghq.eu" } },
      }),
    );
    expect(await screen.findByText("Datadog is connected.")).toBeTruthy();
  });

  it("sets GitHub's App and a token side by side, with a link to a token made for Switch", async () => {
    signedIn();
    const token = pastedConnector().paste[0]!;
    const calls = server(
      serviceConnection({
        slug: "github",
        name: "GitHub",
        publisher: "GitHub",
        web_sign_in: true,
        pass_through: false,
        paste: [
          {
            ...token,
            help_url: "https://docs.github.com/tokens",
            create_url: "https://github.com/settings/personal-access-tokens/new?name=Switch&expires_in=30&contents=write",
          },
        ],
      }),
      [],
      null,
      { "PUT /service-connections/github/paste": { warning: null, external_identity: "octocat" } },
    );
    renderPage("github");

    const choices = await screen.findByRole("region", { name: "Connect GitHub" });
    expect(within(choices).getByRole("region", { name: "Switch GitHub App" })).toBeTruthy();
    expect(within(choices).getByText("Agents act as you, wherever the token reaches")).toBeTruthy();
    expect(within(choices).getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.click(within(choices).getByRole("button", { name: "Use a token" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect GitHub with a personal access token" });
    expect(within(dialog).queryByText(/connect it from Switch Console/)).toBeNull();
    expect(within(dialog).getByRole("link", { name: /Create a token in GitHub/ }).getAttribute("href")).toBe(
      "https://github.com/settings/personal-access-tokens/new?name=Switch&expires_in=30&contents=write",
    );
    expect(within(dialog).getByText("Code: read and write")).toBeTruthy();
    expect(within(dialog).getByText("Expires in 30 days")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Personal access token"), {
      target: { value: "github_pat_example" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/service-connections/github/paste",
        body: { method: "token", fields: { pat: "github_pat_example" }, choices: {} },
      }),
    );
    expect(await screen.findByText("GitHub is connected.")).toBeTruthy();
  });

  it("pastes keys instead where the server takes them", async () => {
    signedIn();
    const calls = server(pastedConnector(), [], null, {
      "PUT /service-connections/datadog/paste": { warning: null, external_identity: "org" },
    });
    renderPage("datadog");

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "API and application keys" }));
    expect(within(dialog).getByText(/Never expires; only Datadog can revoke it\./)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "dd-api" } });
    fireEvent.change(within(dialog).getByLabelText("Application key"), { target: { value: "dd-app" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/service-connections/datadog/paste",
        body: {
          method: "keys",
          fields: { api_key: "dd-api", application_key: "dd-app" },
          choices: { site: "datadoghq.com" },
        },
      }),
    );
  });

  it("says why the vendor refused what was pasted, in the dialog", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(/^\/gateway/, "").split("?")[0];
        if ((init?.method ?? "GET") === "PUT")
          return new Response(JSON.stringify({ detail: "Datadog refused the token." }), { status: 400 });
        if (path === "/service-connections") return new Response(JSON.stringify({ connections: [pastedConnector()] }));
        return new Response(JSON.stringify([]));
      }),
    );
    renderPage("datadog");

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Personal access token"), { target: { value: "bad" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText("Datadog refused the token.")).toBeTruthy();
  });

  it("replaces keys the server no longer takes with a token", async () => {
    signedIn();
    const tokenOnly = pastedConnector().paste.filter((way) => way.method === "token");
    server(
      pastedConnector({
        paste: tokenOnly,
        status: "active",
        can_revoke: true,
        method: "keys",
        choices: { site: "datadoghq.com" },
        access_note: "Reaches what your keys allow.",
      }),
    );
    renderPage("datadog");

    fireEvent.click(await screen.findByRole("button", { name: "Replace token" }));
    expect(await screen.findByRole("dialog", { name: "Replace your Datadog token" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace keys" })).toBeNull();
  });

  it("replaces a token the vendor refused, at the site it was for", async () => {
    signedIn();
    const calls = server(
      pastedConnector({
        status: "needs_reauthorization",
        can_revoke: true,
        method: "token",
        choices: { site: "datadoghq.eu" },
        external_identity: "ada@example.test",
        access_note: "Reaches what your token allows.",
        reconnect_code: "token_refused",
        reconnect_reason: "Datadog refused your token. Paste a new one.",
      }),
      [],
      null,
      { "PUT /service-connections/datadog/paste": { warning: null, external_identity: "ada@example.test" } },
    );
    renderPage("datadog");

    expect(await screen.findByText("Connected as ada@example.test · Reaches what your token allows.")).toBeTruthy();
    expect(screen.getByText("Datadog refused your token. Paste a new one.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace your Datadog token" });
    expect(within(dialog).queryByText(/connect it from Switch Console/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Personal access token"), { target: { value: "ddpat_new" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace token" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/service-connections/datadog/paste",
        body: { method: "token", fields: { pat: "ddpat_new" }, choices: { site: "datadoghq.eu" } },
      }),
    );
    expect(await screen.findByText("Datadog is reconnected.")).toBeTruthy();
  });
});
