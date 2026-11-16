import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import type { Capabilities } from "../data/capabilities";
import { featureFlagsFrom } from "../data/featureFlags";
import type { SettingsArea } from "../data/settingsLanding";
import {
  AREAS as MATRIX_AREAS,
  type MatrixLayout,
  PAGES,
  PERSONAS,
  type Persona,
  RAIL as MATRIX_RAIL,
  REDIRECTS,
  SETTINGS_MENUS,
} from "./roleMatrix";
import { AREAS, accessTo, menuOf, railFor, routesFor } from "./routeTable";
import { PlannedPage } from "./StatusPages";

/** The route table held to the role matrix. The matrix is written from the
 * target matrix, so when this fails, decide which of the two is wrong; a new
 * or newly built page needs its row in `roleMatrix.ts`. */

const LAYOUTS: readonly MatrixLayout[] = ["current", "v2"];

/** What the server tells the dashboard about each role in a workspace of an
 * organization, on a server with the flags the harness's stack turns on. */
function capabilitiesOf(persona: Persona, layout: MatrixLayout): Capabilities {
  const features = featureFlagsFrom(
    ["agent_management", "service_connections", "organization_connector_apps"]
      .concat(layout === "v2" ? ["gateway_v2"] : [])
      .map((key) => ({ key, enabled: true })),
  );
  return {
    isOperator: persona === "operator",
    administersWorkspace: persona !== "member",
    administersOrganization: persona === "orgAdmin",
    inOrganization: true,
    canDeleteWorkspace: persona === "workspaceAdmin",
    canManageDataProtection: persona === "workspaceAdmin",
    features,
  };
}

function sorted(paths: Iterable<string>): string[] {
  return [...paths].sort();
}

describe.each(LAYOUTS)("the role matrix, %s layout", (layout) => {
  const routes = routesFor(layout);

  it("has a row for every page, and no page the route table lacks", () => {
    const pages = routes.filter((route) => route.kind === "page").map((route) => route.path);
    expect(sorted(PAGES[layout].map((row) => row.path))).toEqual(sorted(pages));
  });

  it("says which pages are still to be built", () => {
    const plannedHere = routes
      .filter(
        (route) =>
          route.kind === "page" &&
          isValidElement(route.element) &&
          route.element.type === PlannedPage,
      )
      .map((route) => route.path);
    const plannedInMatrix = PAGES[layout]
      .filter((row) => row.status === "planned")
      .map((row) => row.path);
    expect(sorted(plannedInMatrix)).toEqual(sorted(plannedHere));
  });

  it("has every settings area, and where it opens", () => {
    const areas = routes.flatMap((route) =>
      route.kind === "area" ? [{ path: route.path, first: AREAS[route.area].first }] : [],
    );
    const inMatrix = MATRIX_AREAS[layout].map(({ path, first }) => ({ path, first }));
    expect(inMatrix).toEqual(areas);
  });

  it("has every redirect", () => {
    const redirects = routes.flatMap((route) =>
      route.kind === "redirect" ? [`${route.path} -> ${route.to}`] : [],
    );
    expect(sorted(REDIRECTS[layout].map(({ from, to }) => `${from} -> ${to}`))).toEqual(
      sorted(redirects),
    );
  });

  it.each(PERSONAS)("lets %s open what the matrix says, and nothing else", (persona) => {
    const caps = capabilitiesOf(persona, layout);
    const wrong = [...PAGES[layout], ...MATRIX_AREAS[layout]].flatMap((row) => {
      const expected = row.open.includes(persona);
      const actual = accessTo(row.path, layout, caps)?.allowed === true;
      return expected === actual ? [] : [`${row.path}: matrix ${expected}, route table ${actual}`];
    });
    expect(wrong).toEqual([]);
  });

  it.each(PERSONAS)("shows %s the matrix's rail", (persona) => {
    const rail = railFor(layout, capabilitiesOf(persona, layout)).map((item) => item.label);
    expect(rail).toEqual(MATRIX_RAIL[layout][persona]);
  });
});

describe.each(PERSONAS)("the new layout's settings menus for %s", (persona) => {
  const caps = capabilitiesOf(persona, "v2");
  const areas: readonly SettingsArea[] = ["workspace", "organization", "platform"];

  it.each(areas)("match the matrix in the %s area", (area) => {
    const expected = SETTINGS_MENUS[area][persona];
    const entered = AREAS[area].access(caps).allowed;
    expect(entered ? menuOf(area, "v2", caps).map((item) => item.label) : null).toEqual(expected);
  });
});
