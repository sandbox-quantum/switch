import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EcosystemGraphData, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import { ALL_OFF } from "../../data/featureFlags";
import EcosystemGraphPage from "./EcosystemGraphPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));
// The canvas graph draws nothing in jsdom; the page around it is what is
// tested, plus the props the page hands the graph.
const graphProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("react-force-graph-2d", () => ({
  default: (props: Record<string, unknown>) => {
    graphProps.current = props;
    return null;
  },
}));

function signedInAsAdmin() {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: "admin" as const,
    organization_role: "member" as const,
    organization_id: "o1",
    archived_at: null,
  };
  const session: Session = {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant,
    tenants: [tenant],
    state: "ready",
    can_create_workspace: false,
    can_add_workspace: false,
    invite_email_enabled: false,
  };
  vi.mocked(useAuth).mockReturnValue({
    session,
    capabilities: capabilitiesOf(
      session,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role: "admin",
        administers: true,
        can_delete: false,
        can_manage_data_protection: false,
      },
      ALL_OFF,
    ),
  } as unknown as ReturnType<typeof useAuth>);
}

function answerGraph(graph: EcosystemGraphData) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(graph), { status: 200 })),
  );
}

const SWITCH = { id: "switch", kind: "switch" as const, label: "Switch", sublabel: "" };

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/ecosystem"]}>
      <Routes>
        <Route path="/ecosystem" element={<EcosystemGraphPage />} />
        <Route path="/overview" element={<p>Home page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EcosystemGraphPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    signedInAsAdmin();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("counts agents, their types and the messaging apps", async () => {
    answerGraph({
      show_owners: false,
      nodes: [
        SWITCH,
        { id: "type:codex", kind: "agent_type", label: "codex", sublabel: "1 agent" },
        { id: "agent:a1", kind: "agent", label: "a1", sublabel: "" },
        { id: "bridge:b1", kind: "bridge", label: "Slack", sublabel: "" },
        { id: "bridge:b2", kind: "bridge", label: "Teams", sublabel: "" },
      ],
      edges: [],
    });
    renderPage();
    expect(await screen.findByText("1 agent · 1 type · 2 messaging apps")).toBeTruthy();
  });

  it("says when there is nothing but Switch to draw", async () => {
    answerGraph({ show_owners: false, nodes: [SWITCH], edges: [] });
    renderPage();
    expect(await screen.findByText("No agents or messaging apps yet.")).toBeTruthy();
  });

  it("labels a node with its name and description as text, never markup", async () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    answerGraph({
      show_owners: false,
      nodes: [SWITCH, { id: "agent:a1", kind: "agent", label: payload, sublabel: payload }],
      edges: [],
    });
    renderPage();
    await screen.findByText("1 agent · 0 types · 0 messaging apps");
    await waitFor(() => expect(graphProps.current?.graphData).toBeTruthy());
    const nodeLabel = graphProps.current?.nodeLabel as (node: unknown) => unknown;
    const label = nodeLabel({ id: "agent:a1", kind: "agent", label: payload, sublabel: payload });
    // A string would be written into the page as HTML by the graph's tooltip.
    expect(typeof label).not.toBe("string");
    const { container } = render(label as ReactElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(`${payload}\n${payload}`);
  });

  it("leads back to Home", async () => {
    answerGraph({ show_owners: false, nodes: [SWITCH], edges: [] });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await waitFor(() => expect(screen.getByText("Home page")).toBeTruthy());
  });

  it("offers Show owners only where the server sends owners", async () => {
    answerGraph({ show_owners: false, nodes: [SWITCH], edges: [] });
    renderPage();
    await screen.findByText("No agents or messaging apps yet.");
    expect(screen.queryByLabelText("Show owners")).toBeNull();
    cleanup();

    answerGraph({ show_owners: true, nodes: [SWITCH], edges: [] });
    renderPage();
    expect(await screen.findByLabelText("Show owners")).toBeTruthy();
  });

  it("says the graph couldn't be loaded, and not that there is nothing in it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "database unavailable" }), { status: 503 })),
    );
    renderPage();
    expect(await screen.findByText("Couldn't load the ecosystem: database unavailable")).toBeTruthy();
    expect(screen.queryByText("No agents or messaging apps yet.")).toBeNull();
  });
});
