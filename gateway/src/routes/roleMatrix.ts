/** Who may open each page of the dashboard, role by role: the release gate's
 * expectations, written from the gateway refactor's target role matrix and
 * not from the route table, so each can catch the other being wrong.
 *
 * Two tests hold the dashboard to it:
 *
 * - `roleMatrix.test.ts` asks the route table, with each role's
 *   capabilities, and runs on every gateway change;
 * - the browser lane of the end-to-end harness (`console/tooling-e2e`) signs
 *   in as a real account in each role and opens every page here.
 *
 * Adding a page means adding its row here, in the same change: the first
 * test fails until the two agree.
 *
 * Plain data with no imports, because the harness reads it too. Every page
 * assumes the server has `agent_management`, `service_connections` and
 * `organization_connector_apps` on, as the harness's stack does, and more
 * than one organization: the server's default one and the harness's own. */

/** The roles, each a real account in the harness:
 *
 * - `orgAdmin`: `org_admin` of the workspace's organization;
 * - `workspaceAdmin`: an admin member of the workspace, and no more;
 * - `member`: a plain member of the workspace;
 * - `operator`: the platform operator, entered into a workspace of an
 *   organization it has no role in. */
export type Persona = "orgAdmin" | "workspaceAdmin" | "member" | "operator";

export const PERSONAS: readonly Persona[] = ["orgAdmin", "workspaceAdmin", "member", "operator"];

const EVERYONE = PERSONAS;
/** Whoever administers the workspace: its admins, its organization's admin
 * and the operator. */
const ADMINS: readonly Persona[] = ["orgAdmin", "workspaceAdmin", "operator"];
/** The organization's admin, and the operator, who may restore one. */
const ORGANIZATION_ADMIN_OR_OPERATOR: readonly Persona[] = ["orgAdmin", "operator"];
const ORGANIZATION_ADMIN: readonly Persona[] = ["orgAdmin"];
const OPERATOR: readonly Persona[] = ["operator"];

export interface MatrixPage {
  /** The route's own path, `:name` parameters included. */
  path: string;
  /** Who may open it. Everyone else is shown the no-access page. */
  open: readonly Persona[];
}

/** A settings area's own URL, which opens a page of the area. */
export interface MatrixArea {
  path: string;
  open: readonly Persona[];
  /** Where the area opens for someone who has not been in it yet. */
  first: string;
}

export interface MatrixRedirect {
  from: string;
  /** The redirect's own target, which may redirect again. */
  to: string;
}

function page(path: string, open: readonly Persona[]): MatrixPage {
  return { path, open };
}

export const PAGES: readonly MatrixPage[] = [
  page("/overview", EVERYONE),
  page("/ecosystem", EVERYONE),
  page("/rooms", EVERYONE),
  page("/rooms/new", EVERYONE),
  page("/rooms/groups", EVERYONE),
  page("/rooms/graph", EVERYONE),
  page("/rooms/:roomId", EVERYONE),
  page("/rooms/:roomId/documents/:documentId", EVERYONE),
  page("/resources", EVERYONE),
  page("/resources/references/:id", EVERYONE),
  page("/resources/documents/:id", EVERYONE),
  page("/resources/packages/:id", EVERYONE),
  page("/templates", EVERYONE),
  page("/templates/:id", EVERYONE),
  page("/agents", EVERYONE),
  page("/agents/:agentId", EVERYONE),
  page("/connectors", EVERYONE),
  page("/connectors/:connectorId", EVERYONE),

  page("/settings/general", EVERYONE),
  page("/settings/general/private-channel-rooms", ADMINS),
  page("/settings/users", EVERYONE),
  page("/settings/messaging-apps", EVERYONE),
  page("/settings/connectors", EVERYONE),
  page("/settings/api-keys", EVERYONE),
  page("/settings/guardrails", EVERYONE),
  page("/settings/devices", EVERYONE),
  page("/settings/account", EVERYONE),

  page("/settings/org/general", ORGANIZATION_ADMIN_OR_OPERATOR),
  page("/settings/org/workspaces", ORGANIZATION_ADMIN_OR_OPERATOR),
  // Every member sees who is in the organization, as in Switch Trust.
  page("/settings/org/users", EVERYONE),
  page("/settings/org/connectors", ORGANIZATION_ADMIN),
  // The deployment's connector apps. An organization's admin may set them up
  // only on a deployment with no other organization, which this is not.
  page("/settings/org/connector-apps", OPERATOR),
  page("/settings/org/guardrails", ORGANIZATION_ADMIN),
  page("/settings/org/devices", ORGANIZATION_ADMIN),
  page("/settings/org/audit-log", ORGANIZATION_ADMIN),
];

export const AREAS: readonly MatrixArea[] = [
  { path: "/settings", open: EVERYONE, first: "/settings/general" },
  { path: "/settings/org", open: EVERYONE, first: "/settings/org/general" },
];

/** Every moved page's old URL, so a link from an older Switch Console, the
 * docs or a bookmark still lands on it. */
export const REDIRECTS: readonly MatrixRedirect[] = [
  { from: "/", to: "/overview" },
  { from: "/resources/templates/:id", to: "/templates/:id" },
  { from: "/machines", to: "/settings/devices" },
  { from: "/collaborations", to: "/settings/messaging-apps" },
  { from: "/registration-keys", to: "/settings/api-keys" },
  { from: "/workspace", to: "/settings/users" },
  { from: "/workspace/private-channel-rooms", to: "/settings/general/private-channel-rooms" },
  { from: "/organization", to: "/settings/org" },
  { from: "/usage", to: "/settings" },
  { from: "/users", to: "/settings/org/users" },
  { from: "/operator/workspaces", to: "/settings/org/workspaces" },
  { from: "/platform", to: "/settings/org/workspaces" },
  { from: "/platform/workspaces", to: "/settings/org/workspaces" },
  { from: "/platform/users", to: "/settings/org/users" },
  { from: "/platform/connectors", to: "/settings/org/connector-apps" },
];

// The ecosystem graph has no rail item of its own: Home links to it.
const RAIL_EVERYONE = [
  "Home",
  "Agents",
  "Rooms",
  "Templates",
  "Connectors",
  "Resources",
  "Settings",
];

/** The navigation rail's labels, in order. */
export const RAIL: Record<Persona, readonly string[]> = {
  orgAdmin: RAIL_EVERYONE,
  workspaceAdmin: RAIL_EVERYONE,
  member: RAIL_EVERYONE,
  operator: RAIL_EVERYONE,
};

export type MatrixSettingsArea = "workspace" | "organization";

const WORKSPACE_MENU_EVERYONE = [
  "General",
  "Users",
  "Messaging apps",
  "Connectors",
  "API keys",
  "Guardrails",
];
const WORKSPACE_MENU_MEMBER = [...WORKSPACE_MENU_EVERYONE, "Devices", "Your account"];
const WORKSPACE_MENU_ADMIN = WORKSPACE_MENU_MEMBER;

/** Each settings area's menu, in order: the pages it lists, not the link
 * across to the other area. Null where the role may not
 * enter the area. */
export const SETTINGS_MENUS: Record<MatrixSettingsArea, Record<Persona, readonly string[] | null>> =
  {
    workspace: {
      orgAdmin: WORKSPACE_MENU_ADMIN,
      workspaceAdmin: WORKSPACE_MENU_ADMIN,
      member: WORKSPACE_MENU_MEMBER,
      operator: WORKSPACE_MENU_ADMIN,
    },
    organization: {
      orgAdmin: [
        "General",
        "Workspaces",
        "Users",
        "Connectors",
        "Guardrails",
        "Devices",
        "Audit log",
      ],
      workspaceAdmin: ["Users"],
      member: ["Users"],
      operator: ["General", "Workspaces", "Users", "Connector apps"],
    },
  };
