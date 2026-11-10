import { describe, expect, it } from "vitest";
import { RAIL, areaOf, routesFor } from "./routeTable";

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
