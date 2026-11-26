import { describe, expect, it } from "vitest";
import type { Capabilities } from "../data/capabilities";
import { featureFlagsFrom } from "../data/featureFlags";
import { RAIL, ROUTES, accessTo, areaOf, menuOf, railFor } from "./routeTable";

/** Every page URL the dashboard had before the settings areas. Links to them
 * live on in older Switch Consoles, the docs and bookmarks. */
const EARLIER_URLS = [
  "/",
  "/ecosystem",
  "/rooms",
  "/rooms/new",
  "/rooms/groups",
  "/rooms/graph",
  "/rooms/:roomId",
  "/rooms/:roomId/documents/:documentId",
  "/resources",
  "/resources/references/:id",
  "/resources/documents/:id",
  "/resources/packages/:id",
  "/resources/templates/:id",
  "/agents",
  "/agents/:agentId",
  "/connectors",
  "/machines",
  "/collaborations",
  "/registration-keys",
  "/workspace",
  "/workspace/private-channel-rooms",
  "/organization",
  "/usage",
  "/users",
  "/operator/workspaces",
];

describe("the route table's reach", () => {
  it("still answers every URL the dashboard had, with a page or a redirect", () => {
    const answered = new Set(ROUTES.map((route) => route.path));
    expect(EARLIER_URLS.filter((path) => !answered.has(path))).toEqual([]);
  });

  it("sends each redirect to a page", () => {
    const pages = new Set(ROUTES.filter((r) => r.kind !== "redirect").map((r) => r.path));
    // A redirect may carry a query for the page it leads to (`/chats?tab=rooms`).
    const dangling = ROUTES.filter(
      (r) => r.kind === "redirect" && !pages.has(r.to.split("?")[0]),
    ).map((r) => r.path);
    expect(dangling).toEqual([]);
  });

  it("lights Home on the ecosystem graph, which Home opens, and Settings on Usage & budget", () => {
    const standsFor = (label: string) => RAIL.find((item) => item.label === label)?.activeFor ?? [];
    expect(standsFor("Home")).toContain("/ecosystem");
    expect(standsFor("Settings")).toContain("/usage");
  });

  it("keeps only the settings areas at the foot of the rail", () => {
    expect(RAIL.filter((item) => item.bottom).map((item) => item.to)).toEqual(["/settings"]);
  });

  it("provides stable /manage URLs for room and agent detail pages", () => {
    const answered = new Set(ROUTES.map((route) => route.path));
    expect(answered.has("/rooms/:roomId/manage")).toBe(true);
    expect(answered.has("/agents/:agentId/manage")).toBe(true);
  });
});

describe("areaOf", () => {
  it("names the settings area a page is in", () => {
    expect(areaOf("/settings/org/users")).toBe("organization");
    expect(areaOf("/settings/org")).toBe("organization");
    expect(areaOf("/settings/org/connector-apps")).toBe("organization");
  });

  it("names none for a page outside them, or a URL that only redirects", () => {
    expect(areaOf("/rooms")).toBeNull();
    expect(areaOf("/organization")).toBeNull();
    expect(areaOf("/platform/users")).toBeNull();
  });
});

describe("Connector apps", () => {
  /** An admin of the workspace and its organization, on a server with every
   * flag on, who may or may not set up the deployment's connector apps. */
  function orgAdmin(canManageConnectorApps: boolean): Capabilities {
    return {
      isOperator: false,
      administersWorkspace: true,
      administersOrganization: true,
      inOrganization: true,
      canDeleteWorkspace: true,
      canManageDataProtection: true,
      canManageConnectorApps,
      connectorAppsInDashboard: null,
      features: featureFlagsFrom(
        ["agent_management", "service_connections", "organization_connector_apps"].map((key) => ({
          key,
          enabled: true,
        })),
      ),
    };
  }

  const inMenu = (caps: Capabilities) =>
    menuOf("organization", caps).some((item) => item.path === "/settings/org/connector-apps");

  it("is in Organization settings, and opens, for an admin who may set them up", () => {
    const caps = orgAdmin(true);
    expect(inMenu(caps)).toBe(true);
    expect(accessTo("/settings/org/connector-apps", caps)?.allowed).toBe(true);
  });

  it("is neither listed nor opened by an admin who may not", () => {
    const caps = orgAdmin(false);
    expect(inMenu(caps)).toBe(false);
    expect(accessTo("/settings/org/connector-apps", caps)?.allowed).toBe(false);
  });

  it("sits right after Connectors", () => {
    const labels = menuOf("organization", orgAdmin(true)).map((item) => item.label);
    expect(labels.indexOf("Connector apps")).toBe(labels.indexOf("Connectors") + 1);
  });

  /** Someone in a workspace of no organization, as an older release could
   * make one, who may or may not set up the deployment's connector apps:
   * the operator, or an admin of its only organization. */
  function outsideAnOrganization(canManageConnectorApps: boolean): Capabilities {
    return {
      ...orgAdmin(canManageConnectorApps),
      isOperator: canManageConnectorApps,
      administersOrganization: false,
      inOrganization: false,
    };
  }

  it("opens from a workspace in no organization for whoever may set them up, and nothing else there does", () => {
    const caps = outsideAnOrganization(true);
    expect(accessTo("/settings/org", caps)?.allowed).toBe(true);
    expect(accessTo("/settings/org/connector-apps", caps)?.allowed).toBe(true);
    expect(menuOf("organization", caps).map((item) => item.path)).toEqual([
      "/settings/org/connector-apps",
    ]);
    for (const path of [
      "/settings/org/general",
      "/settings/org/workspaces",
      "/settings/org/users",
      "/settings/org/audit-log",
    ]) {
      expect(accessTo(path, caps)).toEqual({
        allowed: false,
        reason: "not_permitted",
        message: "This workspace belongs to no organization.",
      });
    }
  });

  it("keeps Organization settings shut, from a workspace in no organization, to anyone else", () => {
    const caps = outsideAnOrganization(false);
    expect(accessTo("/settings/org", caps)).toEqual({
      allowed: false,
      reason: "not_permitted",
      message: "This workspace belongs to no organization.",
    });
    expect(accessTo("/settings/org/connector-apps", caps)?.allowed).toBe(false);
  });
});

describe("Organization settings for everyone else", () => {
  it("still admits only the organization's admins and the operator to its pages", () => {
    const flags = featureFlagsFrom(
      ["agent_management", "service_connections", "organization_connector_apps"].map((key) => ({
        key,
        enabled: true,
      })),
    );
    const member: Capabilities = {
      isOperator: false,
      administersWorkspace: true,
      administersOrganization: false,
      inOrganization: true,
      canDeleteWorkspace: true,
      canManageDataProtection: true,
      canManageConnectorApps: false,
      connectorAppsInDashboard: true,
      features: flags,
    };
    for (const path of ["/settings/org", "/settings/org/general", "/settings/org/users"]) {
      expect(accessTo(path, member)).toEqual({
        allowed: false,
        reason: "not_permitted",
        message: "Only the organization's admins can open this page.",
      });
    }
    const operator = { ...member, isOperator: true, canManageConnectorApps: true };
    for (const path of ["/settings/org/general", "/settings/org/users", "/settings/org/connector-apps"]) {
      expect(accessTo(path, operator)?.allowed).toBe(true);
    }
  });
});

describe("Message routing", () => {
  function caps(administersWorkspace: boolean, decisionRouting: boolean): Capabilities {
    return {
      isOperator: false,
      administersWorkspace,
      administersOrganization: false,
      inOrganization: true,
      canDeleteWorkspace: false,
      canManageDataProtection: false,
      canManageConnectorApps: false,
      connectorAppsInDashboard: null,
      features: featureFlagsFrom([
        { key: "agent_management", enabled: true },
        { key: "decision_routing", enabled: decisionRouting },
      ]),
    };
  }

  it("is accessible to workspace admins when decision_routing is enabled", () => {
    const admin = caps(true, true);
    expect(accessTo("/settings/message-routing", admin)?.allowed).toBe(true);
  });

  it("is hidden from non-admins even when decision_routing is enabled", () => {
    const member = caps(false, true);
    expect(accessTo("/settings/message-routing", member)).toEqual({
      allowed: false,
      reason: "not_permitted",
      message: "Only this workspace's admins can open this page.",
    });
  });

  it("is hidden when decision_routing is disabled, even for admins", () => {
    const admin = caps(true, false);
    expect(accessTo("/settings/message-routing", admin)).toEqual({
      allowed: false,
      reason: "not_enabled",
      flag: "decision_routing",
      message: "Message routing isn't turned on here.",
    });
  });
});

describe("the rail", () => {
  function member(chats: boolean): Capabilities {
    return {
      isOperator: false,
      administersWorkspace: false,
      administersOrganization: false,
      inOrganization: true,
      canDeleteWorkspace: false,
      canManageDataProtection: false,
      canManageConnectorApps: false,
      connectorAppsInDashboard: null,
      features: featureFlagsFrom([{ key: "gateway_chats", enabled: chats }]),
    };
  }
  const item = (caps: Capabilities, label: string) =>
    railFor(caps).find((each) => each.label === label);

  it("takes Agents to the agents list Home links to, and lights it only there", () => {
    for (const chats of [true, false]) {
      expect(item(member(chats), "Agents")).toMatchObject({ to: "/agents", activeFor: ["/agents"] });
    }
  });

  it("leaves rooms to Chats where there are chats, and keeps Rooms only where there are none", () => {
    expect(item(member(true), "Rooms")).toBeUndefined();
    expect(item(member(true), "Chats")).toMatchObject({ to: "/chats", activeFor: ["/chats", "/rooms"] });
    expect(item(member(false), "Chats")).toBeUndefined();
    expect(item(member(false), "Rooms")?.to).toBe("/rooms");
  });

  it("makes /rooms and /rooms/new pages anyone may open only where there are no chats", () => {
    for (const path of ["/rooms", "/rooms/new"]) {
      expect(accessTo(path, member(true))).toBeNull();
      expect(accessTo(path, member(false))?.allowed).toBe(true);
    }
  });
});
