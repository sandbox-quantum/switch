import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDetail } from "../../data/api";
import type { UseQueryResult } from "../../data/hooks";
import RoomGraphView from "./RoomGraphView";

vi.mock("../../data/api", () => ({
  fetchLinkedRooms: vi.fn(async () => []),
  fetchInboundLinkedRooms: vi.fn(async () => []),
}));

// Holds whatever the current test wants useRoom() to answer.
const roomQuery = vi.hoisted(() => ({ current: null as UseQueryResult<RoomDetail> | null }));
vi.mock("../../data/hooks", () => ({
  useRoom: () => roomQuery.current,
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

function roomDetail(overrides: Partial<RoomDetail>): RoomDetail {
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
    transport_room_id: "!r1:switch.local",
    matrix_room_id: "!r1:switch.local",
    external_channel_id: null,
    instructions: null,
    observe_config: null,
    agent_ids: [],
    agent_statuses: {},
    roles: [],
    join_event_listeners: [],
    archived_at: null,
    channel_on_delete: null,
    ...overrides,
  };
}

describe("RoomGraphView", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    graphProps.current = null;
    roomQuery.current = null;
  });

  it("labels the center room's node with its name and description as text, never markup", async () => {
    const name = '<img src=x onerror="alert(1)">';
    const description = "<b>markup</b>";
    roomQuery.current = {
      data: roomDetail({ id: "r1", name, description }),
      loading: false,
      error: null,
      errorStatus: null,
      refetch: vi.fn(),
    };

    render(<RoomGraphView roomId="r1" />);

    await waitFor(() => {
      const data = graphProps.current?.graphData as { nodes: unknown[] } | undefined;
      expect(data?.nodes.length).toBeGreaterThan(0);
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
