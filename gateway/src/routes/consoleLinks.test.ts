import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PARAM,
  agentPagePath,
  connectorAppsPagePath,
  roomPagePath,
  settingsPagePath,
} from "../../../console/apps/switch-console-desktop/src/shared/core/switch-servers/dashboard-pages";
import { linkedWorkspace } from "../data/workspaceLink";
import { ROUTES } from "./routeTable";

/** Whether `path` is a page or a settings area, not a redirect or nothing at
 * all: a link Switch Console opens must land where it says. A redirect that
 * holds only on some servers is a page on the others, so it opens where its
 * target does. */
function opens(path: string): boolean {
  const route = ROUTES.find((each) => each.path === `/${path}`);
  if (route === undefined) return false;
  if (route.kind !== "redirect") return true;
  return route.only !== undefined && opens(route.to.slice(1).split("?")[0]);
}

/** Whether `path` is answered at all, if only by a redirect. */
function answers(path: string): boolean {
  return ROUTES.some((route) => route.path === `/${path}`);
}

describe("the pages Switch Console opens", () => {
  it("opens workspace and organization settings, and still answers the old URLs", () => {
    // Console picks the old URLs for a server that reports gateway_v2 off,
    // which a server older than the settings areas does.
    for (const link of ["workspace-settings", "organization-settings"] as const) {
      expect(opens(settingsPagePath(link, true))).toBe(true);
      expect(answers(settingsPagePath(link, false))).toBe(true);
    }
  });

  // Console's `platform` page is for a server from before Organization
  // settings had Connector apps; here it only redirects.
  it("opens the deployment's connector apps in Organization settings", () => {
    expect(opens(connectorAppsPagePath("organization-settings"))).toBe(true);
    expect(answers(connectorAppsPagePath("platform"))).toBe(true);
  });

  it("opens a room's page and an agent's page", () => {
    expect(opens(roomPagePath(":roomId"))).toBe(true);
    expect(opens(agentPagePath(":agentId"))).toBe(true);
  });

  it("names the workspace the way the dashboard reads it", () => {
    expect(linkedWorkspace(`?${WORKSPACE_PARAM}=t2`)).toBe("t2");
  });
});
