/** Who may open each page of the dashboard, role by role: the release gate's
 * expectations, written from the gateway refactor's target role matrix and
 * not from the route table, so each can catch the other being wrong.
 *
 * Two tests hold the dashboard to it:
 *
 * - `roleMatrix.test.ts` asks the route table, with each role's
 *   capabilities, and runs on every gateway change;
 * - the browser lane of the end-to-end harness (`console/tooling-e2e`) signs
 *   in as a real account in each role, on a server with the new layout off
 *   and on, and opens every page here.
 *
 * Adding or building a page means adding or updating its row here, in the
 * same change: the first test fails until the two agree.
 *
 * Plain data with no imports, because the harness reads it too. Every page
 * assumes the server has `agent_management`, `service_connections` and
 * `organization_connector_apps` on, as the harness's stack does. */

/** The roles, each a real account in the harness:
 *
 * - `orgAdmin`: `org_admin` of the workspace's organization;
 * - `workspaceAdmin`: an admin member of the workspace, and no more;
 * - `member`: a plain member of the workspace;
 * - `operator`: the platform operator, entered into a workspace of an
 *   organization it has no role in. */
export type Persona = "orgAdmin" | "workspaceAdmin" | "member" | "operator";

export type MatrixLayout = "current" | "v2";

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
  /** Built, or a slot of the new layout still showing "isn't built yet". */
  status: "built" | "planned";
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

function built(path: string, open: readonly Persona[]): MatrixPage {
  return { path, open, status: "built" };
}

function planned(path: string, open: readonly Persona[]): MatrixPage {
  return { path, open, status: "planned" };
}

export const PAGES: Record<MatrixLayout, readonly MatrixPage[]> = {
  current: [
    built("/ecosystem", EVERYONE),
    built("/rooms", EVERYONE),
    built("/rooms/new", EVERYONE),
    built("/rooms/groups", EVERYONE),
    built("/rooms/graph", EVERYONE),
    built("/rooms/:roomId", EVERYONE),
    built("/rooms/:roomId/documents/:documentId", EVERYONE),
    built("/resources", EVERYONE),
    built("/resources/references/:id", EVERYONE),
    built("/resources/documents/:id", EVERYONE),
    built("/resources/packages/:id", EVERYONE),
    built("/resources/templates/:id", EVERYONE),
    built("/agents", EVERYONE),
    built("/agents/:agentId", EVERYONE),
    built("/connectors", OPERATOR),
    built("/machines", EVERYONE),
    built("/collaborations", EVERYONE),
    built("/registration-keys", EVERYONE),
    built("/workspace", EVERYONE),
    built("/workspace/private-channel-rooms", ADMINS),
    // Every workspace is in an organization, and today's page shows it to
    // anyone in one; what it lets them do is the page's own business.
    built("/organization", EVERYONE),
    built("/usage", ADMINS),
    built("/users", OPERATOR),
    built("/operator/workspaces", OPERATOR),
  ],
  v2: [
    built("/overview", EVERYONE),
    built("/ecosystem", EVERYONE),
    built("/rooms", EVERYONE),
    built("/rooms/new", EVERYONE),
    built("/rooms/groups", EVERYONE),
    built("/rooms/graph", EVERYONE),
    built("/rooms/:roomId", EVERYONE),
    built("/rooms/:roomId/documents/:documentId", EVERYONE),
    built("/resources", EVERYONE),
    built("/resources/references/:id", EVERYONE),
    built("/resources/documents/:id", EVERYONE),
    built("/resources/packages/:id", EVERYONE),
    built("/templates", EVERYONE),
    built("/templates/:id", EVERYONE),
    built("/agents", EVERYONE),
    built("/agents/:agentId", EVERYONE),
    planned("/connectors", EVERYONE),
    built("/connectors/:connectorId", EVERYONE),

    built("/settings/general", EVERYONE),
    built("/workspace/private-channel-rooms", ADMINS),
    built("/settings/users", EVERYONE),
    built("/settings/messaging-apps", EVERYONE),
    built("/settings/connectors", EVERYONE),
    built("/settings/api-keys", EVERYONE),
    built("/settings/guardrails", EVERYONE),
    built("/settings/devices", EVERYONE),
    built("/usage", ADMINS),
    planned("/settings/account", EVERYONE),

    built("/settings/org/general", ORGANIZATION_ADMIN_OR_OPERATOR),
    built("/settings/org/workspaces", ORGANIZATION_ADMIN_OR_OPERATOR),
    built("/settings/org/users", ORGANIZATION_ADMIN_OR_OPERATOR),
    built("/settings/org/connectors", ORGANIZATION_ADMIN),
    built("/settings/org/guardrails", ORGANIZATION_ADMIN),
    planned("/settings/org/devices", ORGANIZATION_ADMIN),
    built("/settings/org/audit-log", ORGANIZATION_ADMIN),

    built("/platform/workspaces", OPERATOR),
    built("/platform/users", OPERATOR),
    built("/platform/connectors", OPERATOR),
  ],
};

export const AREAS: Record<MatrixLayout, readonly MatrixArea[]> = {
  current: [],
  v2: [
    { path: "/settings", open: EVERYONE, first: "/settings/general" },
    { path: "/settings/org", open: ORGANIZATION_ADMIN_OR_OPERATOR, first: "/settings/org/general" },
    { path: "/platform", open: OPERATOR, first: "/platform/workspaces" },
  ],
};

/** Every moved page's old URL in the new layout, and every new URL in
 * today's, so a link from Console or the docs works with the flag either way. */
export const REDIRECTS: Record<MatrixLayout, readonly MatrixRedirect[]> = {
  current: [
    { from: "/", to: "/rooms" },
    { from: "/overview", to: "/" },
    { from: "/templates", to: "/resources?tab=templates" },
    { from: "/templates/:id", to: "/resources/templates/:id" },
    { from: "/settings", to: "/workspace" },
    { from: "/settings/general", to: "/workspace" },
    { from: "/settings/users", to: "/workspace" },
    { from: "/settings/messaging-apps", to: "/collaborations" },
    { from: "/settings/api-keys", to: "/registration-keys" },
    { from: "/settings/devices", to: "/machines" },
    { from: "/settings/org", to: "/organization" },
    { from: "/settings/org/general", to: "/organization" },
    { from: "/settings/org/workspaces", to: "/organization" },
    { from: "/settings/org/users", to: "/organization" },
    { from: "/settings/org/connectors", to: "/organization" },
    { from: "/settings/org/guardrails", to: "/organization" },
    { from: "/settings/org/audit-log", to: "/organization" },
    { from: "/platform", to: "/operator/workspaces" },
    { from: "/platform/workspaces", to: "/operator/workspaces" },
    { from: "/platform/users", to: "/users" },
    { from: "/platform/connectors", to: "/connectors" },
  ],
  v2: [
    { from: "/", to: "/overview" },
    { from: "/resources/templates/:id", to: "/templates/:id" },
    { from: "/machines", to: "/settings/devices" },
    { from: "/collaborations", to: "/settings/messaging-apps" },
    { from: "/registration-keys", to: "/settings/api-keys" },
    { from: "/workspace", to: "/settings/users" },
    { from: "/organization", to: "/settings/org" },
    { from: "/users", to: "/platform/users" },
    { from: "/operator/workspaces", to: "/platform/workspaces" },
  ],
};

const CURRENT_RAIL_MEMBER = [
  "Ecosystem",
  "Rooms",
  "Resources",
  "Agents",
  "Apps",
  "API keys",
  "Workspace",
  "Organization",
  "Devices",
];
// The ecosystem graph has no rail item of its own: Overview links to it.
const V2_RAIL = ["Overview", "Agents", "Rooms", "Templates", "Connectors", "Resources", "Settings"];

/** The navigation rail's labels, in order. */
export const RAIL: Record<MatrixLayout, Record<Persona, readonly string[]>> = {
  current: {
    orgAdmin: [...CURRENT_RAIL_MEMBER, "Usage"],
    workspaceAdmin: [...CURRENT_RAIL_MEMBER, "Usage"],
    member: CURRENT_RAIL_MEMBER,
    operator: [...CURRENT_RAIL_MEMBER, "Usage", "All workspaces", "Users", "Connectors"],
  },
  v2: {
    orgAdmin: V2_RAIL,
    workspaceAdmin: V2_RAIL,
    member: V2_RAIL,
    operator: [...V2_RAIL, "Platform"],
  },
};

export type MatrixSettingsArea = "workspace" | "organization" | "platform";

const WORKSPACE_MENU_MEMBER = [
  "General",
  "Users",
  "Messaging apps",
  "Connectors",
  "API keys",
  "Guardrails",
  "Devices",
];
const WORKSPACE_MENU_ADMIN = [...WORKSPACE_MENU_MEMBER, "Usage & budget", "Your account"];

/** Each settings area's menu in the new layout, in order: the pages it
 * lists, not the link across to the other area. Null where the role may not
 * enter the area. */
export const SETTINGS_MENUS: Record<MatrixSettingsArea, Record<Persona, readonly string[] | null>> =
  {
    workspace: {
      orgAdmin: WORKSPACE_MENU_ADMIN,
      workspaceAdmin: WORKSPACE_MENU_ADMIN,
      member: [...WORKSPACE_MENU_MEMBER, "Your account"],
      operator: WORKSPACE_MENU_ADMIN,
    },
    organization: {
      orgAdmin: [
        "General",
        "Workspaces",
        "Users",
        "Connectors and apps",
        "Guardrails",
        "Devices",
        "Audit log",
      ],
      workspaceAdmin: null,
      member: null,
      operator: ["General", "Workspaces", "Users"],
    },
    platform: {
      orgAdmin: null,
      workspaceAdmin: null,
      member: null,
      operator: ["All workspaces", "Users", "Connectors"],
    },
  };
