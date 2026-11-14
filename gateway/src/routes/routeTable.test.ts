import { describe, expect, it } from "vitest";
import type { Capabilities } from "../data/capabilities";
import { featureFlagsFrom } from "../data/featureFlags";
import { type PageRoute, RAIL, areaOf, routesFor } from "./routeTable";

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
    expect(RAIL.v2.filter((item) => item.bottom).map((item) => item.to)).toEqual([
      "/settings",
      "/platform",
    ]);
    expect(RAIL.current.some((item) => item.bottom)).toBe(false);
  });
});

describe("areaOf", () => {
  it("names the settings area a page is in", () => {
    expect(areaOf("/settings/org/users", "v2")).toBe("organization");
    expect(areaOf("/settings/org", "v2")).toBe("organization");
    expect(areaOf("/usage", "v2")).toBe("workspace");
    expect(areaOf("/platform/users", "v2")).toBe("platform");
  });

  it("names none for a page outside them, or a URL that only redirects", () => {
    expect(areaOf("/rooms", "v2")).toBeNull();
    expect(areaOf("/usage", "current")).toBeNull();
    expect(areaOf("/settings/org", "current")).toBeNull();
  });
});

describe("the platform operator's pages", () => {
  /** Everything but the operator bit: an admin of the workspace and its
   * organization, on a server with every flag on. */
  const EVERYTHING_BUT_OPERATOR: Capabilities = {
    isOperator: false,
    administersWorkspace: true,
    administersOrganization: true,
    inOrganization: true,
    canDeleteWorkspace: true,
    canManageDataProtection: true,
    features: featureFlagsFrom(
      ["agent_management", "service_connections", "organization_connector_apps", "gateway_v2"].map(
        (key) => ({ key, enabled: true }),
      ),
    ),
  };

  /** The Platform area's pages, and today's pages that moved into it. */
  function operatorPages(): PageRoute[] {
    const movedToPlatform = new Set(
      routesFor("v2")
        .filter((route) => route.kind === "redirect" && route.to.startsWith("/platform/"))
        .map((route) => route.path),
    );
    return [
      ...routesFor("v2").filter(
        (route): route is PageRoute => route.kind === "page" && route.area === "platform",
      ),
      ...routesFor("current").filter(
        (route): route is PageRoute => route.kind === "page" && movedToPlatform.has(route.path),
      ),
    ];
  }

  it("covers the pages it should", () => {
    expect(operatorPages().map((route) => route.path)).toEqual([
      "/platform/workspaces",
      "/platform/users",
      "/platform/connectors",
      "/users",
      "/operator/workspaces",
    ]);
  });

  it("each refuse anyone else by their own rule, not only through the area", () => {
    const admitted = operatorPages()
      .filter((route) => route.access(EVERYTHING_BUT_OPERATOR).allowed)
      .map((route) => route.path);
    expect(admitted).toEqual([]);
  });
});
