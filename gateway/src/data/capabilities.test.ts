import { describe, expect, it } from "vitest";
import type { CurrentTenant, Session, TenantMembership } from "./api";
import {
  agentManagement,
  allOf,
  capabilitiesOf,
  everyone,
  operators,
  organizationAdmins,
  serviceConnections,
  workspaceAdmins,
} from "./capabilities";
import { ALL_OFF, featureFlagsFrom } from "./featureFlags";

const membership: TenantMembership = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  role: "member",
  organization_role: "member",
  organization_id: "o1",
};

function session(tenant: Partial<TenantMembership> = {}, isOperator = false): Session {
  const current = { ...membership, ...tenant };
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: isOperator },
    tenant: current,
    tenants: [current],
    state: "ready",
    can_create_workspace: false,
    can_add_workspace: false,
    invite_email_enabled: false,
  };
}

function tenant(administers: boolean): CurrentTenant {
  return { id: "t1", slug: "acme", name: "Acme", role: "member", administers, can_delete: false, can_manage_data_protection: false };
}

describe("featureFlagsFrom", () => {
  it("keeps the flags the dashboard knows, and treats any it was not sent as off", () => {
    const flags = featureFlagsFrom([
      { key: "agent_management", enabled: true },
      { key: "gateway_v2", enabled: false },
      { key: "something_newer", enabled: true },
    ]);
    expect(flags).toEqual({
      agent_management: true,
      service_connections: false,
      organization_connector_apps: false,
      gateway_v2: false,
      gateway_chats: false,
      group_chats: false,
    });
  });
});

describe("capabilitiesOf", () => {
  it("takes workspace admin from the server's answer, not the role name", () => {
    expect(capabilitiesOf(session({ role: "admin" }), tenant(false), ALL_OFF).administersWorkspace).toBe(
      false,
    );
    expect(capabilitiesOf(session({ role: "member" }), tenant(true), ALL_OFF).administersWorkspace).toBe(
      true,
    );
  });

  it("is no admin of anything with no workspace", () => {
    const caps = capabilitiesOf(null, null, ALL_OFF);
    expect(caps.administersWorkspace).toBe(false);
    expect(caps.administersOrganization).toBe(false);
    expect(caps.isOperator).toBe(false);
  });

  it("takes organization admin from the organization role, not the operator bit", () => {
    expect(
      capabilitiesOf(session({ organization_role: "org_admin" }), tenant(true), ALL_OFF)
        .administersOrganization,
    ).toBe(true);
    expect(capabilitiesOf(session({}, true), tenant(true), ALL_OFF).administersOrganization).toBe(false);
  });
});

describe("rules", () => {
  const member = capabilitiesOf(session(), tenant(false), ALL_OFF);
  const workspaceAdmin = capabilitiesOf(session({ role: "admin" }), tenant(true), ALL_OFF);
  const orgAdmin = capabilitiesOf(session({ organization_role: "org_admin" }), tenant(true), ALL_OFF);
  const operator = capabilitiesOf(session({}, true), tenant(true), ALL_OFF);
  const outsideAnyOrganization = capabilitiesOf(
    session({ organization_role: null, organization_id: null }),
    tenant(true),
    ALL_OFF,
  );

  it("lets everyone in", () => {
    expect(everyone(member).allowed).toBe(true);
  });

  it("lets workspace admins in, whatever made them one", () => {
    expect(workspaceAdmins(member)).toMatchObject({ allowed: false, reason: "not_permitted" });
    for (const caps of [workspaceAdmin, orgAdmin, operator]) {
      expect(workspaceAdmins(caps).allowed).toBe(true);
    }
  });

  it("lets only the operator into operator pages", () => {
    for (const caps of [member, workspaceAdmin, orgAdmin]) {
      expect(operators(caps).allowed).toBe(false);
    }
    expect(operators(operator).allowed).toBe(true);
  });

  it("lets organization admins and the operator into organization settings", () => {
    expect(organizationAdmins(orgAdmin).allowed).toBe(true);
    expect(organizationAdmins(operator).allowed).toBe(true);
    expect(organizationAdmins(workspaceAdmin)).toMatchObject({
      allowed: false,
      message: "Only the organization's admins can open this page.",
    });
    expect(organizationAdmins(member).allowed).toBe(false);
    expect(organizationAdmins(outsideAnyOrganization)).toMatchObject({
      allowed: false,
      message: "This workspace belongs to no organization.",
    });
  });

  it("refuses a page whose feature is off, naming the flag", () => {
    expect(agentManagement(member)).toEqual({
      allowed: false,
      reason: "not_enabled",
      flag: "agent_management",
      message: "Agent management isn't turned on here.",
    });
    const on = capabilitiesOf(session(), tenant(false), { ...ALL_OFF, agent_management: true });
    expect(agentManagement(on).allowed).toBe(true);
  });

  it("answers with the first refusal when several rules apply", () => {
    const rule = allOf(serviceConnections, workspaceAdmins);
    expect(rule(member)).toMatchObject({ reason: "not_enabled", flag: "service_connections" });
    const on = capabilitiesOf(session(), tenant(false), { ...ALL_OFF, service_connections: true });
    expect(rule(on)).toMatchObject({ reason: "not_permitted" });
  });
});
