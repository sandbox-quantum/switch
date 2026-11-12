import { describe, expect, it } from "vitest";
import type { AgentSummary, CurrentTenant, RoomSummary, Session } from "./api";
import { capabilitiesOf } from "./capabilities";
import { ALL_OFF } from "./featureFlags";
import { agentsInScope, listScopeOf, roomsInScope } from "./listScope";

function capabilities(administers: boolean, isOperator = false) {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: "member" as const,
    organization_role: null,
    organization_id: null,
  };
  const session: Session = {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: isOperator },
    tenant,
    tenants: [tenant],
    state: "ready",
    can_create_workspace: false,
    can_add_workspace: false,
    invite_email_enabled: false,
  };
  const current: CurrentTenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: "member",
    administers,
    can_delete: false,
    can_manage_data_protection: false,
  };
  return capabilitiesOf(session, current, ALL_OFF);
}

const agent = (id: string, ownerId: string | null, parentId: string | null = null) =>
  ({ id, owner_id: ownerId, parent_agent_id: parentId }) as unknown as AgentSummary;

const room = (id: string, viewerIsMember: boolean) =>
  ({ id, viewer_is_member: viewerIsMember }) as unknown as RoomSummary;

describe("listScopeOf", () => {
  it("shows whoever administers the workspace all of it, and a member their own", () => {
    expect(listScopeOf(capabilities(true))).toBe("workspace");
    expect(listScopeOf(capabilities(false))).toBe("yours");
  });

  it("goes by what the server says about administering, the operator included", () => {
    // The server's `administers` already counts the operator bit.
    expect(listScopeOf(capabilities(true, true))).toBe("workspace");
  });
});

describe("agentsInScope", () => {
  const agents = [agent("a1", "u1"), agent("a2", "u1", "a1"), agent("b1", "u2"), agent("c1", null)];

  it("keeps every agent for the workspace", () => {
    expect(agentsInScope(agents, "workspace", "u1")).toHaveLength(4);
  });

  it("keeps a member's own agents, their sub-agents included", () => {
    expect(agentsInScope(agents, "yours", "u1").map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

describe("roomsInScope", () => {
  const rooms = [room("r1", true), room("r2", false)];

  it("keeps every room for the workspace", () => {
    expect(roomsInScope(rooms, "workspace")).toHaveLength(2);
  });

  it("keeps the rooms a member takes part in", () => {
    expect(roomsInScope(rooms, "yours").map((r) => r.id)).toEqual(["r1"]);
  });
});
