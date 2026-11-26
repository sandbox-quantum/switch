import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomGraphData, RoomGroupDetail, RoomSummary, Session } from "../../data/api";
import { loadRoomsWithArchived } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import { ALL_OFF } from "../../data/featureFlags";
import { useRoomGraph, useRoomGroups } from "../../data/hooks";
import RoomsGraphPage from "./RoomsGraphPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../data/api", () => ({
  // useLoad (used by this page) checks `instanceof ApiError` on a failed
  // load; a stand-in keeps that check safe even though these tests never
  // exercise the error path.
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  loadRoomsWithArchived: vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useRoomGraph: vi.fn(),
  useRoomGroups: vi.fn(),
}));

// The canvas graph draws nothing in jsdom; the props it is handed are what is
// tested, as EcosystemGraphPage.test.tsx does for the ecosystem graph.
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
    can_manage_connector_apps: false,
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

function room(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    id: "r1",
    name: "Room",
    description: "",
    channel_type: null,
    admin_mode: false,
    agent_count: 0,
    connected_user_count: 0,
    connected_user_names: [],
    bridge_id: null,
    bridge_display_name: null,
    bridge_type: null,
    group_id: null,
    group_name: null,
    owner_id: null,
    owner_name: null,
    read_visibility: "public",
    write_visibility: "public",
    created_at: "2024-01-01T00:00:00Z",
    archived: false,
    viewer_is_member: true,
    can_write: true,
    can_manage: true,
    can_attach: true,
    can_invite_agents: true,
    can_add_people: true,
    can_remove_members: true,
    can_unlink: true,
    can_transfer: true,
    ...overrides,
  };
}

const emptyGroups: RoomGroupDetail[] = [];
const emptyGraph: RoomGraphData = { rooms: [], links: [], groups: [] };

describe("RoomsGraphPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    signedInAsAdmin();
    vi.mocked(useRoomGroups).mockReturnValue({
      data: emptyGroups,
      loading: false,
      error: null,
      errorStatus: null,
      refetch: vi.fn(),
    });
    vi.mocked(useRoomGraph).mockReturnValue({
      data: emptyGraph,
      loading: false,
      error: null,
      errorStatus: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    graphProps.current = null;
  });

  it("labels a room node with its name and description as text, never markup", async () => {
    const name = '<img src=x onerror="alert(1)">';
    const description = "<b>markup</b>";
    vi.mocked(loadRoomsWithArchived).mockResolvedValue([room({ id: "r1", name, description })]);

    render(
      <MemoryRouter>
        <RoomsGraphPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const data = graphProps.current?.graphData as { nodes: unknown[] } | undefined;
      expect(data?.nodes.length).toBe(1);
    });

    const nodeLabel = graphProps.current?.nodeLabel as (node: unknown) => unknown;
    const label = nodeLabel({ id: "r1", label: name, description });
    // A string would be written into the page as HTML by the graph's tooltip.
    expect(typeof label).not.toBe("string");
    const { container } = render(label as ReactElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe(`${name}\n${description}`);
  });
});
