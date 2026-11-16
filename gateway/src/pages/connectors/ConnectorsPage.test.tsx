import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceConnection } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { pastedConnector, serviceConnection } from "../../test/serviceConnection";
import ConnectorsPage from "./ConnectorsPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

function signedIn({ admin = false } = {}) {
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "me", name: "Ada", email: "ada@example.test", is_operator: false },
      tenant: { id: "t1", slug: "acme", name: "Acme", role: admin ? "admin" : "member", organization_role: null, organization_id: "o1" },
    },
    capabilities: { administersWorkspace: admin, administersOrganization: false, features: { gateway_v2: true } },
    isOperator: false,
  } as unknown as ReturnType<typeof useAuth>);
}

interface Call {
  method: string;
  path: string;
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
      calls.push({ method, path });
      const key = `${method} ${path}`;
      if (!(key in routes)) return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 404 });
      const reply = routes[key];
      if (reply instanceof Reply) return new Response(JSON.stringify(reply.body), { status: reply.status });
      return new Response(JSON.stringify(reply), { status: 200 });
    }),
  );
  return calls;
}

const google = serviceConnection({
  slug: "google-workspace",
  name: "Google Workspace",
  category: "Productivity",
  description: "Drive, Docs and Calendar.",
  web_sign_in: true,
});
const atlassian = serviceConnection({ slug: "atlassian", name: "Atlassian", category: "Project management" });
const datadog = serviceConnection({
  slug: "datadog",
  name: "Datadog",
  category: "Observability",
  auth_type: "api_key",
  key: { fields: [{ name: "api_key", label: "API key", secret: true, help: null, choices: null }], help_url: null },
});
const asana = serviceConnection({ slug: "asana", name: "Asana", enabled: false, connectable: false });

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/connectors"]}>
      <Routes>
        <Route path="/connectors" element={<ConnectorsPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}


const originalLocation = window.location;
const assign = vi.fn();

describe("the Connectors catalogue", () => {
  beforeEach(() => {
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalLocation, assign } });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    assign.mockClear();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: originalLocation });
  });

  it("opens on yours, and All lists everything with what isn't built yet last", async () => {
    signedIn();
    const connected: ServiceConnection = { ...atlassian, status: "active", can_revoke: true };
    answer({ "GET /service-connections": { connections: [asana, connected, datadog, google] } });
    renderPage();

    expect(await screen.findByRole("img", { name: "Connected to Atlassian" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yours" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Google Workspace")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const shown = screen.getAllByText(/^(Google Workspace|Atlassian|Datadog|Asana)$/).map((node) => node.textContent);
    expect(shown).toEqual(["Atlassian", "Datadog", "Google Workspace", "Asana"]);
    expect(screen.getByText("Coming soon")).toBeTruthy();
  });

  it("opens on All when nothing is connected yet, and says so on Yours", async () => {
    signedIn();
    answer({ "GET /service-connections": { connections: [google] } });
    renderPage();

    expect(await screen.findByText("Google Workspace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Yours" }));
    expect(screen.getByText("You haven't connected anything yet. The All tab lists every connector.")).toBeTruthy();
  });

  it("connects through the sign-in that comes back here, from the card's plus", async () => {
    signedIn();
    const calls = answer({
      "GET /service-connections": { connections: [google] },
      "POST /service-connections/google-workspace/flows/web": { id: "flow-1", url: "https://switch.example.test/authorize?state=flow-1" },
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Workspace" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://switch.example.test/authorize?state=flow-1"));
    expect(calls).toContainEqual({ method: "POST", path: "/service-connections/google-workspace/flows/web" });
  });

  it("connects GitHub from its card through its own App's flow", async () => {
    signedIn();
    const calls = answer({
      "GET /service-connections": { connections: [serviceConnection({ slug: "github", name: "GitHub", web_sign_in: true })] },
      "POST /provider-connections/github/flows/web": { id: "flow-2", url: "https://switch.example.test/gh?state=flow-2" },
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://switch.example.test/gh?state=flow-2"));
    expect(calls).toContainEqual({ method: "POST", path: "/provider-connections/github/flows/web" });
  });

  it("gives the plus back when the browser returns the page from its cache", async () => {
    signedIn();
    answer({
      "GET /service-connections": { connections: [google] },
      "POST /service-connections/google-workspace/flows/web": { id: "flow-1", url: "https://switch.example.test/authorize" },
    });
    renderPage();

    const plus = await screen.findByRole("button", { name: "Connect Google Workspace" });
    fireEvent.click(plus);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect((screen.getByRole("button", { name: "Connect Google Workspace" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays on All after connecting the first one", async () => {
    signedIn();
    const connections = [datadog, google];
    answer({
      "GET /service-connections": { connections },
      "PUT /service-connections/datadog/key": { warning: null, external_identity: "org-1" },
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Connect Datadog" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "dd-key" } });
    connections[0] = { ...datadog, status: "active", can_revoke: true };
    fireEvent.click(within(dialog).getByRole("button", { name: "Add keys" }));

    expect(await screen.findByRole("img", { name: "Connected to Datadog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Google Workspace")).toBeTruthy();
  });

  it("says why a sign-in could not start", async () => {
    signedIn();
    answer({
      "GET /service-connections": { connections: [google] },
      "POST /service-connections/google-workspace/flows/web": new Reply(409, { detail: "Google Workspace can't be connected from the web here." }),
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Workspace" }));
    expect(await screen.findByText("Google Workspace can't be connected from the web here.")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("takes a key from the card's plus, and offers none where the sign-in finishes in Console", async () => {
    signedIn();
    answer({ "GET /service-connections": { connections: [atlassian, datadog] } });
    renderPage();

    expect(await screen.findByText("Atlassian")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Atlassian" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect Datadog" }));
    expect(within(await screen.findByRole("dialog")).getByLabelText("API key")).toBeTruthy();
  });

  it("takes a token pasted in place of a sign-in from the card's plus", async () => {
    signedIn();
    answer({ "GET /service-connections": { connections: [pastedConnector()] } });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Connect Datadog" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Datadog" });
    expect(within(dialog).getByRole("combobox", { name: "Datadog site" })).toBeTruthy();
    expect(within(dialog).getByLabelText("Personal access token")).toBeTruthy();
  });

  it("shows a connector the workspace has off, saying so, with no way to connect it", async () => {
    signedIn();
    answer({
      "GET /service-connections": {
        connections: [{ ...google, workspace_enabled: false, decided_by: "workspace" }],
      },
    });
    renderPage();

    expect(await screen.findByText("Off here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Google Workspace" })).toBeNull();
  });

  it("says a connector nobody can connect here is unavailable", async () => {
    signedIn();
    answer({
      "GET /service-connections": {
        connections: [{ ...google, connectable: false, unavailable_reason: "Switch's Google Workspace app isn't set up." }],
      },
    });
    renderPage();

    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Google Workspace" })).toBeNull();
  });

  it("marks a connection that needs a fresh sign-in", async () => {
    signedIn();
    answer({
      "GET /service-connections": { connections: [{ ...google, status: "needs_reauthorization", can_revoke: true }] },
    });
    renderPage();

    expect(await screen.findByRole("img", { name: "Google Workspace needs reconnecting" })).toBeTruthy();
  });

  it("shows a workspace admin how many people connected each one, and a member none", async () => {
    signedIn({ admin: true });
    answer({
      "GET /service-connections": { connections: [google, atlassian] },
      "GET /workspace/services": {
        services: [
          { slug: "google-workspace", connected_members: 3 },
          { slug: "atlassian", connected_members: 1 },
        ],
      },
    });
    renderPage();
    expect(await screen.findByText("Productivity · 3 people connected")).toBeTruthy();
    expect(screen.getByText("Project management · 1 person connected")).toBeTruthy();

    cleanup();
    signedIn();
    const calls = answer({ "GET /service-connections": { connections: [google] } });
    renderPage();
    expect(await screen.findByText("Productivity")).toBeTruthy();
    expect(calls.map((call) => call.path)).not.toContain("/workspace/services");
  });

  it("still shows the catalogue when the counts can't be read, and says they are missing", async () => {
    signedIn({ admin: true });
    answer({
      "GET /service-connections": { connections: [google] },
      "GET /workspace/services": new Reply(500, { detail: "Database unavailable" }),
    });
    renderPage();

    expect(await screen.findByText(/couldn't be read: Database unavailable/)).toBeTruthy();
    expect(screen.getByText("Productivity")).toBeTruthy();
  });

  it("searches by name or category", async () => {
    signedIn();
    answer({ "GET /service-connections": { connections: [google, atlassian, datadog] } });
    renderPage();

    fireEvent.change(await screen.findByLabelText("Search connectors"), { target: { value: "observ" } });
    expect(screen.getByText("Datadog")).toBeTruthy();
    expect(screen.queryByText("Atlassian")).toBeNull();
  });

  it("opens a connector's page from its card", async () => {
    signedIn();
    answer({ "GET /service-connections": { connections: [atlassian] } });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Atlassian/ }));
    expect(screen.getByTestId("where").textContent).toBe("/connectors/atlassian");
  });
});
