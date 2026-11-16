import { describe, expect, it } from "vitest";
import type { Capabilities } from "../data/capabilities";
import { featureFlagsFrom } from "../data/featureFlags";
import { type PageRoute, RAIL, ROUTES, areaOf } from "./routeTable";

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
    const dangling = ROUTES.filter((r) => r.kind === "redirect" && !pages.has(r.to)).map(
      (r) => r.path,
    );
    expect(dangling).toEqual([]);
  });

  it("keeps only the settings areas at the foot of the rail", () => {
    expect(RAIL.filter((item) => item.bottom).map((item) => item.to)).toEqual([
      "/settings",
      "/platform",
    ]);
  });
});

describe("areaOf", () => {
  it("names the settings area a page is in", () => {
    expect(areaOf("/settings/org/users")).toBe("organization");
    expect(areaOf("/settings/org")).toBe("organization");
    expect(areaOf("/usage")).toBe("workspace");
    expect(areaOf("/platform/users")).toBe("platform");
  });

  it("names none for a page outside them, or a URL that only redirects", () => {
    expect(areaOf("/rooms")).toBeNull();
    expect(areaOf("/organization")).toBeNull();
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
      ["agent_management", "service_connections", "organization_connector_apps"].map((key) => ({
        key,
        enabled: true,
      })),
    ),
  };

  const operatorPages = ROUTES.filter(
    (route): route is PageRoute => route.kind === "page" && route.area === "platform",
  );

  it("covers the pages it should, and the old URLs lead there", () => {
    expect(operatorPages.map((route) => route.path)).toEqual([
      "/platform/workspaces",
      "/platform/users",
      "/platform/connectors",
    ]);
    const into = ROUTES.filter((r) => r.kind === "redirect" && r.to.startsWith("/platform/"));
    expect(into.map((r) => r.path)).toEqual(["/users", "/operator/workspaces"]);
  });

  it("each refuse anyone else by their own rule, not only through the area", () => {
    const admitted = operatorPages
      .filter((route) => route.access(EVERYTHING_BUT_OPERATOR).allowed)
      .map((route) => route.path);
    expect(admitted).toEqual([]);
  });
});
