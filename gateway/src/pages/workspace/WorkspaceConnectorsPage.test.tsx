import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceService, WorkspaceServices } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import WorkspaceConnectorsPage, { UNAVAILABLE, metaText } from "./WorkspaceConnectorsPage";

// Read through Vite rather than node:fs, which the gateway has no types for.
const brokerSource = Object.values(
  import.meta.glob<string>("../../../../core/switch_core/connections/broker.py", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

function service(overrides: Partial<WorkspaceService> & Pick<WorkspaceService, "slug" | "name">): WorkspaceService {
  return {
    category: "Developer tools",
    description: `${overrides.name}, for agents.`,
    auth_type: "oauth",
    enabled: false,
    decided_by: "workspace_default",
    organization_locked: false,
    organization_default: null,
    can_change: true,
    updated_by_name: null,
    updated_at: null,
    workspace_set: false,
    app_source: "server",
    unavailable_reason: null,
    unavailable_code: null,
    connected_members: 0,
    granted_agents: 0,
    ...overrides,
  };
}

/** What the server answers for each call, and every call made. */
let listing: WorkspaceServices;
let mutations: { method: string; path: string; body: unknown }[];
let mutationAnswer: [number, unknown];

function serve() {
  mutations = [];
  mutationAnswer = [200, { warning: null }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/gateway/, "");
      const method = init?.method ?? "GET";
      if (method === "GET" && path === "/workspace/services")
        return new Response(JSON.stringify(listing), { status: 200 });
      mutations.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(mutationAnswer[1]), { status: mutationAnswer[0] });
    }),
  );
}

function asAdmin(services: WorkspaceService[]) {
  listing = { can_change: true, on_by_default: false, organization_name: "Acme Corp", services };
}

function asMember(services: WorkspaceService[]) {
  listing = {
    can_change: false,
    on_by_default: false,
    organization_name: "Acme Corp",
    services: services.map((s) => ({ ...s, can_change: false, connected_members: null, granted_agents: null })),
  };
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/settings/connectors"]}>
      <Routes>
        <Route path="/settings/connectors" element={<WorkspaceConnectorsPage />} />
        <Route path="/connectors/:connectorId" element={<p>Connector profile</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function loaded() {
  await waitFor(() => expect(screen.queryByLabelText("Loading connectors")).toBeNull());
}

const GITHUB = service({ slug: "github", name: "GitHub" });
const DATADOG = service({ slug: "datadog", name: "Datadog", auth_type: "api_key", category: "Observability" });

describe("WorkspaceConnectorsPage", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      session: { tenant: { name: "Acme" } },
    } as unknown as ReturnType<typeof useAuth>);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("gives an admin a switch per connector, which waits for the server before it flips", async () => {
    asAdmin([GITHUB, DATADOG]);
    serve();
    renderPage();
    await loaded();

    expect(screen.queryByRole("status", { name: /admins/ })).toBeNull();
    const github = screen.getByRole("switch", { name: "GitHub available in Acme" }) as HTMLInputElement;
    expect(screen.getByRole("switch", { name: "Datadog available in Acme" })).toBeTruthy();

    listing = { ...listing, services: [{ ...GITHUB, enabled: true, decided_by: "workspace" }, DATADOG] };
    fireEvent.click(github);
    expect(github.checked).toBe(false);

    await waitFor(() =>
      expect((screen.getByRole("switch", { name: "GitHub available in Acme" }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect(mutations).toEqual([{ method: "PUT", path: "/workspace/services/github", body: { enabled: true } }]);
  });

  it("asks before turning off a connector people and agents use, naming both", async () => {
    asAdmin([{ ...GITHUB, enabled: true, decided_by: "workspace", connected_members: 3, granted_agents: 1 }]);
    serve();
    renderPage();
    await loaded();

    fireEvent.click(screen.getByRole("switch", { name: "GitHub available in Acme" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/3 people have it connected and 1 agent uses it/)).toBeTruthy();
    expect(mutations).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mutations).toEqual([{ method: "PUT", path: "/workspace/services/github", body: { enabled: false } }]);
  });

  it("shows the warning a switch-off comes back with", async () => {
    asAdmin([{ ...GITHUB, enabled: true, decided_by: "workspace" }]);
    serve();
    mutationAnswer = [200, { warning: "Some access stays valid until it expires." }];
    renderPage();
    await loaded();

    fireEvent.click(screen.getByRole("switch", { name: "GitHub available in Acme" }));
    expect(await screen.findByText("Some access stays valid until it expires.")).toBeTruthy();
  });

  it("shows a refusal and reads the page again", async () => {
    asAdmin([GITHUB]);
    serve();
    mutationAnswer = [409, { detail: "Your organization has GitHub locked off for its workspaces." }];
    renderPage();
    await loaded();

    listing = {
      ...listing,
      services: [{ ...GITHUB, decided_by: "organization_locked", organization_locked: true, can_change: false }],
    };
    fireEvent.click(screen.getByRole("switch", { name: "GitHub available in Acme" }));

    expect(await screen.findByText("Your organization has GitHub locked off for its workspaces.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
    expect(screen.getByText("Off for Acme Corp")).toBeTruthy();
  });

  it("gives a member the state in words under a read-only banner, without who it reaches", async () => {
    asMember([
      { ...GITHUB, enabled: true, decided_by: "workspace", updated_by_name: "Ines", connected_members: 3 },
      DATADOG,
    ]);
    serve();
    renderPage();
    await loaded();

    expect(screen.getByText("Only this workspace's admins can change which connectors it uses.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByText("Set here by Ines · Switch's app")).toBeTruthy();
    expect(screen.queryByText(/\d+ (person|people)/)).toBeNull();
  });

  it.each([
    ["an admin", asAdmin],
    ["a member", asMember],
  ])("gives %s no switch on a connector the organization locked", async (_, as) => {
    as([
      { ...GITHUB, enabled: true, decided_by: "organization_locked", organization_locked: true, can_change: false },
      { ...DATADOG, decided_by: "organization_locked", organization_locked: true, can_change: false },
    ]);
    serve();
    renderPage();
    await loaded();

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Off for Acme Corp")).toBeTruthy();
    expect(screen.getAllByText(/^Set by Acme Corp/)).toHaveLength(2);
  });

  it("names the organization's default, and lets an admin who set their own go back to it", async () => {
    asAdmin([
      { ...GITHUB, enabled: true, decided_by: "organization_default", organization_default: true },
      { ...DATADOG, decided_by: "workspace", organization_default: true, workspace_set: true },
    ]);
    serve();
    renderPage();
    await loaded();

    expect(screen.getByText(/^Acme Corp's default/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Use Acme Corp's default/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Use Acme Corp's default for Datadog: on" }));

    await waitFor(() => expect(mutations).toEqual([{ method: "DELETE", path: "/workspace/services/datadog", body: undefined }]));
  });

  it("lets an admin who set their own go back to the workspace's default where the organization has none", async () => {
    asAdmin([{ ...GITHUB, enabled: true, decided_by: "workspace", workspace_set: true }]);
    serve();
    renderPage();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Use this workspace's default for GitHub: off" }));

    await waitFor(() =>
      expect(mutations).toEqual([{ method: "DELETE", path: "/workspace/services/github", body: undefined }]),
    );
  });

  it("offers no way back to a default to a member, or for a connector already on one", async () => {
    asMember([{ ...GITHUB, enabled: true, decided_by: "workspace", organization_default: false }]);
    serve();
    renderPage();
    await loaded();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();

    cleanup();
    asAdmin([{ ...GITHUB, decided_by: "organization_default", organization_default: false }, DATADOG]);
    serve();
    renderPage();
    await loaded();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("asks before going back to a default that turns it off for people using it", async () => {
    asAdmin([
      {
        ...GITHUB,
        enabled: true,
        decided_by: "workspace",
        organization_default: false,
        connected_members: 2,
        granted_agents: 0,
      },
    ]);
    serve();
    renderPage();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Use Acme Corp's default for GitHub: off" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(mutations).toEqual([]);
  });

  it("says when Switch's configuration has a connector off, with no switch to fight it", async () => {
    asAdmin([
      {
        ...GITHUB,
        enabled: true,
        decided_by: "workspace",
        unavailable_code: "switched_off",
        unavailable_reason: "GitHub is switched off on this server.",
      },
    ]);
    serve();
    renderPage();
    await loaded();

    expect(screen.getByText("Off for everyone")).toBeTruthy();
    expect(screen.getByText("Set here · Turned off in Switch's configuration")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("opens the connector's page from its card", async () => {
    asAdmin([GITHUB]);
    serve();
    renderPage();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    expect(await screen.findByText("Connector profile")).toBeTruthy();
  });

  it("says what nobody set leaves it as", async () => {
    asAdmin([GITHUB]);
    serve();
    renderPage();
    await loaded();
    expect(screen.getByText(/Connectors nobody has set, here or in Acme Corp, are off\./)).toBeTruthy();
  });
});

describe("metaText", () => {
  const meta = (overrides: Partial<WorkspaceService>) =>
    metaText({ ...GITHUB, connected_members: null, granted_agents: null, ...overrides }, "Acme Corp");

  it("names whose app an OAuth connector signs in through", () => {
    expect(meta({ app_source: "organization" })).toBe("Off by default · Your organization's app");
    expect(meta({ app_source: "server", enabled: true })).toBe("On by default · Switch's app");
  });

  it("names no app for a connector connected with a key", () => {
    expect(meta({ auth_type: "api_key" })).toBe("Off by default");
  });

  it("has a few words for every reason the server gives", () => {
    const declared = /UnavailableCode = Literal\[([\s\S]*?)\]/.exec(brokerSource ?? "")?.[1];
    expect(declared).toBeTruthy();
    const codes = [...(declared ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(0);
    expect(Object.keys(UNAVAILABLE).sort()).toEqual(codes.sort());
  });

  it("still says it can't be used for a reason it doesn't know and the server doesn't word", () => {
    expect(meta({ unavailable_code: "something_newer", unavailable_reason: null })).toBe(
      "Off by default · Unavailable",
    );
  });

  it("says what stops anyone using it in place of the app", () => {
    expect(meta({ unavailable_code: "app_not_set_up", unavailable_reason: "long" })).toBe(
      "Off by default · Switch's app isn't set up",
    );
    expect(meta({ unavailable_code: "something_new", unavailable_reason: "The server's own words." })).toBe(
      "Off by default · The server's own words.",
    );
  });

  it("counts who it reaches for an admin, once anyone is reached", () => {
    expect(meta({ connected_members: 1, granted_agents: 2 })).toBe("Off by default · Switch's app · 1 person, 2 agents");
    expect(meta({ connected_members: 0, granted_agents: 0 })).toBe("Off by default · Switch's app");
  });
});
