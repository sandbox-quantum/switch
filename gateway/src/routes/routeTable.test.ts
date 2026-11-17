import { describe, expect, it } from "vitest";
import type { Capabilities } from "../data/capabilities";
import { featureFlagsFrom } from "../data/featureFlags";
import { RAIL, accessTo, areaOf, menuOf, routesFor } from "./routeTable";

describe("the new layout's reach", () => {
  it("answers every URL of today's layout, with a page or a redirect", () => {
    const v2 = new Set(routesFor("v2").map((route) => route.path));
    const missing = routesFor("current")
      .filter((route) => route.kind === "page")
      .map((route) => route.path)
      .filter((path) => !v2.has(path));
    expect(missing).toEqual([]);
  });

  it("keeps only the settings areas at the foot of the rail", () => {
    expect(RAIL.v2.filter((item) => item.bottom).map((item) => item.to)).toEqual(["/settings"]);
    expect(RAIL.current.some((item) => item.bottom)).toBe(false);
  });
});

describe("areaOf", () => {
  it("names the settings area a page is in", () => {
    expect(areaOf("/settings/org/users", "v2")).toBe("organization");
    expect(areaOf("/settings/org", "v2")).toBe("organization");
    expect(areaOf("/usage", "v2")).toBe("workspace");
    expect(areaOf("/settings/org/connector-apps", "v2")).toBe("organization");
  });

  it("names none for a page outside them, or a URL that only redirects", () => {
    expect(areaOf("/rooms", "v2")).toBeNull();
    expect(areaOf("/usage", "current")).toBeNull();
    expect(areaOf("/settings/org", "current")).toBeNull();
    expect(areaOf("/platform/users", "v2")).toBeNull();
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
        ["agent_management", "service_connections", "organization_connector_apps", "gateway_v2"].map(
          (key) => ({ key, enabled: true }),
        ),
      ),
    };
  }

  const inMenu = (caps: Capabilities) =>
    menuOf("organization", "v2", caps).some((item) => item.path === "/settings/org/connector-apps");

  it("is in Organization settings, and opens, for an admin who may set them up", () => {
    const caps = orgAdmin(true);
    expect(inMenu(caps)).toBe(true);
    expect(accessTo("/settings/org/connector-apps", "v2", caps)?.allowed).toBe(true);
    expect(accessTo("/connectors", "current", caps)?.allowed).toBe(true);
  });

  it("is neither listed nor opened by an admin who may not", () => {
    const caps = orgAdmin(false);
    expect(inMenu(caps)).toBe(false);
    expect(accessTo("/settings/org/connector-apps", "v2", caps)?.allowed).toBe(false);
    expect(accessTo("/connectors", "current", caps)?.allowed).toBe(false);
  });

  it("sits right after Connectors and apps", () => {
    const labels = menuOf("organization", "v2", orgAdmin(true)).map((item) => item.label);
    expect(labels.indexOf("Connector apps")).toBe(labels.indexOf("Connectors and apps") + 1);
  });
});
