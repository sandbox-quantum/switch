import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PARAM,
  agentPagePath,
  roomPagePath,
  settingsPagePath,
} from "../../../console/apps/switch-console-desktop/src/shared/core/switch-servers/dashboard-pages";
import { linkedWorkspace } from "../data/workspaceLink";
import { type Layout, routesFor } from "./routeTable";

/** Whether `path` is a page or a settings area of `layout`, not a redirect
 * or nothing at all: a link Switch Console opens must land where it says. */
function opensIn(layout: Layout, path: string): boolean {
  return routesFor(layout).some((route) => route.kind !== "redirect" && route.path === `/${path}`);
}

describe("the pages Switch Console opens", () => {
  it("opens workspace and organization settings where each layout keeps them", () => {
    for (const link of ["workspace-settings", "organization-settings"] as const) {
      expect(opensIn("current", settingsPagePath(link, false))).toBe(true);
      expect(opensIn("v2", settingsPagePath(link, true))).toBe(true);
    }
  });

  it("opens a room's page and an agent's page in either layout", () => {
    for (const layout of ["current", "v2"] as const) {
      expect(opensIn(layout, roomPagePath(":roomId"))).toBe(true);
      expect(opensIn(layout, agentPagePath(":agentId"))).toBe(true);
    }
  });

  it("names the workspace the way the dashboard reads it", () => {
    expect(linkedWorkspace(`?${WORKSPACE_PARAM}=t2`)).toBe("t2");
  });
});
