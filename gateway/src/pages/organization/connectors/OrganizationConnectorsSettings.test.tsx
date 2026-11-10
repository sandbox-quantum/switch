import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorApp, OrganizationService } from "../../../data/api";
import { app } from "../../connector-apps/testFixtures";
import OrganizationConnectorsSettings from "./OrganizationConnectorsSettings";

function service(overrides: Partial<OrganizationService> = {}): OrganizationService {
  return {
    slug: "github",
    name: "GitHub",
    category: "Source control",
    description: "Clone, branch, push and open pull requests.",
    setting: null,
    updated_by_name: null,
    updated_at: null,
    server_switched_off: null,
    workspaces_on: 2,
    workspaces_set_own: 0,
    connected_members: 4,
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Answers each `METHOD /path` from `routes`, and records every call. */
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

function lists(services: OrganizationService[], apps: ConnectorApp[]) {
  return {
    "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
    "GET /organizations/current/services": { workspaces: 3, services },
    "GET /organizations/current/connector-apps": { public_url: "https://switch.example.test", apps },
  };
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function renderAt(path = "/settings/org/connectors") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/settings/org/connectors"
          element={
            <>
              <OrganizationConnectorsSettings />
              <Where />
            </>
          }
        />
        <Route path="/connectors/:connectorId" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Organization settings › Connectors and apps", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each connector with how far the organization's setting reaches", async () => {
    answer(
      lists(
        [
          service({
            setting: { enabled: true, locked: false },
            workspaces_set_own: 1,
            updated_by_name: "Ada",
            updated_at: "2026-11-03T10:00:00Z",
          }),
        ],
        [],
      ),
    );
    renderAt();

    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(screen.getByText("On by default")).toBeTruthy();
    expect(screen.getByText(/On in 2 of 3 workspaces · 1 sets its own · 4 people connected · set by Ada/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "GitHub available in Acme Inc" })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("asks before turning a connector off everywhere, then locks it off", async () => {
    const calls = answer({
      ...lists([service()], []),
      "PUT /organizations/current/services/github": { warning: null },
    });
    renderAt();

    fireEvent.click(await screen.findByRole("switch", { name: "GitHub available in Acme Inc" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Turn GitHub off in every workspace?")).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off everywhere" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/organizations/current/services/github",
        body: { enabled: false, locked: true },
      }),
    );
  });

  it("turns a connector back on by handing the choice to each workspace", async () => {
    const calls = answer({
      ...lists([service({ setting: { enabled: false, locked: true } })], []),
      "DELETE /organizations/current/services/github": { warning: null },
    });
    renderAt();

    fireEvent.click(await screen.findByRole("switch", { name: "GitHub available in Acme Inc" }));

    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
        "DELETE /organizations/current/services/github",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sets the other settings from the menu beside the switch", async () => {
    const calls = answer({
      ...lists([service()], []),
      "PUT /organizations/current/services/github": { warning: "Sibling could not be reached." },
    });
    renderAt();

    fireEvent.click(await screen.findByRole("button", { name: "More settings for GitHub" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /On in every workspace/ }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/organizations/current/services/github",
        body: { enabled: true, locked: true },
      }),
    );
    expect(await screen.findByText("Sibling could not be reached.")).toBeTruthy();
  });

  it("offers the organization's app in place of a switch that couldn't take effect", async () => {
    answer(
      lists(
        [service({ slug: "google-workspace", name: "Google Workspace" })],
        [app({ source: "none", saved_client_id: null, server_app: false, created_at: null })],
      ),
    );
    renderAt();

    fireEvent.click(await screen.findByRole("button", { name: "Set up org account" }));

    expect(screen.queryByRole("switch")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        "/settings/org/connectors?tab=apps&app=google-workspace",
      ),
    );
    // Today's setup wizard, opened for that app.
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("keeps the switch where Switch's own app serves the workspaces", async () => {
    answer(
      lists(
        [service({ slug: "google-workspace", name: "Google Workspace" })],
        [app({ source: "none", saved_client_id: null, server_app: true, created_at: null })],
      ),
    );
    renderAt();

    expect(
      await screen.findByRole("switch", { name: "Google Workspace available in Acme Inc" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up org account" })).toBeNull();
  });

  it("opens a connector's page, with the way back here", async () => {
    answer(lists([service()], []));
    renderAt();

    fireEvent.click(await screen.findByText("GitHub"));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/connectors/github"));
  });

  it("lists the apps with who set them up, and opens one in the panel", async () => {
    answer(lists([], [app()]));
    renderAt("/settings/org/connectors?tab=apps");

    const row = await screen.findByTestId("org-app-google-workspace");
    expect(within(row).getByText("Set up")).toBeTruthy();
    expect(within(row).getByText("Set up 2026-10-01 · changed by Ada, 2026-10-15")).toBeTruthy();
    fireEvent.click(within(row).getByText("Google Workspace"));

    const panel = await screen.findByRole("region", { name: "Google Workspace app" });
    expect(within(panel).getByText("example-client-id")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toContain("app=google-workspace");
  });

  it("counts what removing an app touches before it goes", async () => {
    answer(lists([], [app({ server_app: true })]));
    renderAt("/settings/org/connectors?tab=apps&app=google-workspace");

    const panel = await screen.findByRole("region", { name: "Google Workspace app" });
    fireEvent.click(within(panel).getByRole("button", { name: "More for Google Workspace" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog", { name: /Remove Google Workspace/ });
    expect(within(dialog).getByText("Your workspaces go back to Switch's Google Workspace app.")).toBeTruthy();
    expect(within(dialog).getByText("3 workspaces move to Switch's app.")).toBeTruthy();
    expect(within(dialog).getByText("12 connected accounts must reconnect before they work again.")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "5 agent grants stop working until their owners reconnect. The grants themselves are kept.",
      ),
    ).toBeTruthy();
  });
});
