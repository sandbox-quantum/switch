import { describe, expect, it } from "vitest";
import type { Capabilities } from "../data/capabilities";
import { featureFlagsFrom } from "../data/featureFlags";
import type { SettingsArea } from "../data/settingsLanding";
import {
  AREAS as MATRIX_AREAS,
  MENU_FLAGS,
  type MatrixState,
  PAGES,
  PERSONAS,
  type Persona,
  RAIL as MATRIX_RAIL,
  REDIRECTS,
  settingsMenu,
  stateAt,
} from "./roleMatrix";
import { AREAS, ROUTES, accessTo, menuOf, railFor } from "./routeTable";

/** The route table held to the role matrix. The matrix is written from the
 * target matrix, so when this fails, decide which of the two is wrong; a new
 * page needs its row in `roleMatrix.ts`. */

/** The flags every page of the matrix assumes on. */
const ASSUMED = [
  "agent_management",
  "service_connections",
  "organization_connector_apps",
  "gateway_chats",
  "gateway_onboarding",
];

/** The flags some pages of the matrix name, each held with it on and off. */
const NAMED = [
  ...new Set([
    ...PAGES.flatMap((row) => (row.flag === undefined ? [] : [row.flag])),
    ...Object.values(MENU_FLAGS).flatMap((menu) => Object.values(menu)),
  ]),
];

/** Every named flag on, and every one off. */
const FLAG_SETS: readonly (readonly string[])[] = [[...ASSUMED, ...NAMED], ASSUMED];

/** What the server tells the dashboard about each role in a workspace of an
 * organization, on a server with `flags` on. */
function capabilitiesOf(persona: Persona, flags: readonly string[]): Capabilities {
  const features = featureFlagsFrom(flags.map((key) => ({ key, enabled: true })));
  return {
    isOperator: persona === "operator",
    administersWorkspace: persona !== "member",
    administersOrganization: persona === "orgAdmin",
    inOrganization: true,
    canDeleteWorkspace: persona === "workspaceAdmin",
    canManageDataProtection: persona === "workspaceAdmin",
    // The harness's deployment has more than one organization (the server's
    // default one and the scenario's), so the organization's admin may not set
    // up the deployment's connector apps there, and the operator may: it
    // enters Organization settings as the operator and finds Connector apps.
    canManageConnectorApps: persona === "operator",
    connectorAppsInDashboard: false,
    features,
  };
}

function sorted(paths: Iterable<string>): string[] {
  return [...paths].sort();
}

describe("the role matrix", () => {
  it("has a row for every page, and no page the route table lacks", () => {
    const pages = ROUTES.filter((route) => route.kind === "page").map((route) => route.path);
    expect(sorted(PAGES.map((row) => row.path))).toEqual(sorted(pages));
  });

  it("has every settings area, and where it opens", () => {
    const areas = ROUTES.flatMap((route) =>
      route.kind === "area" ? [{ path: route.path, first: AREAS[route.area].first }] : [],
    );
    const inMatrix = MATRIX_AREAS.map(({ path, first }) => ({ path, first }));
    expect(inMatrix).toEqual(areas);
  });

  it("has every redirect", () => {
    const redirects = ROUTES.flatMap((route) =>
      route.kind === "redirect" ? [`${route.path} -> ${route.to}`] : [],
    );
    expect(sorted(REDIRECTS.map(({ from, to }) => `${from} -> ${to}`))).toEqual(sorted(redirects));
  });

  describe.each(FLAG_SETS.map((flags) => [flags.join(", "), flags] as const))(
    "with %s on",
    (_, flags) => {
      it.each(PERSONAS)("lets %s open what the matrix says, and nothing else", (persona) => {
        const caps = capabilitiesOf(persona, flags);
        const wrong = [...PAGES, ...MATRIX_AREAS].flatMap((row) => {
          const expected = stateAt(row, persona, new Set(flags));
          const access = accessTo(row.path, caps);
          const actual: MatrixState = access?.allowed
            ? "page"
            : access?.reason === "not_enabled"
              ? "not-enabled"
              : "refused";
          return expected === actual ? [] : [`${row.path}: matrix ${expected}, route table ${actual}`];
        });
        expect(wrong).toEqual([]);
      });

      it.each(PERSONAS)("shows %s the matrix's rail", (persona) => {
        const rail = railFor(capabilitiesOf(persona, flags)).map((item) => item.label);
        expect(rail).toEqual(MATRIX_RAIL[persona]);
      });

      describe.each(PERSONAS)("the settings menus for %s", (persona) => {
        const caps = capabilitiesOf(persona, flags);
        const areas: readonly SettingsArea[] = ["workspace", "organization"];

        it.each(areas)("match the matrix in the %s area", (area) => {
          const expected = settingsMenu(area, persona, new Set(flags));
          const entered = AREAS[area].access(caps).allowed;
          expect(entered ? menuOf(area, caps).map((item) => item.label) : null).toEqual(expected);
        });
      });
    },
  );
});
