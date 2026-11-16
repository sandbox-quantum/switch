import AdminPanelSettingsOutlined from "@mui/icons-material/AdminPanelSettingsOutlined";
import DashboardOutlined from "@mui/icons-material/DashboardOutlined";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import MeetingRoomOutlined from "@mui/icons-material/MeetingRoomOutlined";
import PowerOutlined from "@mui/icons-material/PowerOutlined";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import type { ComponentType, ReactNode } from "react";
import {
  type Access,
  type Capabilities,
  type Rule,
  agentManagement,
  allOf,
  everyone,
  operators,
  organizationAdmins,
  organizationAdminsOnly,
  organizationConnectorApps,
  serviceConnections,
  workspaceAdmins,
} from "../data/capabilities";
import type { SettingsArea } from "../data/settingsLanding";
import AccountPage from "../pages/account/AccountPage";
import AgentDetailPage from "../pages/agents/AgentDetailPage";
import ApiKeysPage from "../pages/api-keys/ApiKeysPage";
import AgentListPage from "../pages/agents/AgentListPage";
import ConnectorAppsPage from "../pages/connector-apps/ConnectorAppsPage";
import EcosystemGraphPage from "../pages/ecosystem/EcosystemGraphPage";
import MessagingAppsPage from "../pages/messaging-apps/MessagingAppsPage";
import OperatorWorkspacesPage from "../pages/operator/OperatorWorkspacesPage";
import ConnectorPage from "../pages/connectors/ConnectorPage";
import ConnectorsPage from "../pages/connectors/ConnectorsPage";
import {
  OrganizationAuditLogPage,
  OrganizationConnectorsPage,
  OrganizationGeneralPage,
  OrganizationDevicesPage,
  OrganizationGuardrailsPage,
  OrganizationUsersPage,
  OrganizationWorkspacesPage,
} from "../pages/organization/OrganizationPage";
import OverviewPage from "../pages/overview/OverviewPage";
import DocumentDetailPage from "../pages/resources/DocumentDetailPage";
import PackageDetailPage from "../pages/resources/PackageDetailPage";
import ReferenceDetailPage from "../pages/resources/ReferenceDetailPage";
import ResourcesPage from "../pages/resources/ResourcesPage";
import TemplateDetailPage from "../pages/resources/TemplateDetailPage";
import DevicesPage from "../pages/devices/DevicesPage";
import CreateRoomPage from "../pages/rooms/CreateRoomPage";
import WorkspaceGuardrailsPage from "../pages/guardrails/WorkspaceGuardrailsPage";
import GroupsPage from "../pages/rooms/GroupsPage";
import RoomDetailPage from "../pages/rooms/RoomDetailPage";
import RoomScopedDocumentView from "../pages/rooms/RoomScopedDocumentView";
import RoomsGraphPage from "../pages/rooms/RoomsGraphPage";
import RoomsPage from "../pages/rooms/RoomsPage";
import TemplatesPage from "../pages/templates/TemplatesPage";
import UsagePage from "../pages/usage/UsagePage";
import UsersPage from "../pages/users/UsersPage";
import PrivateChannelRoomsPage from "../pages/workspace/PrivateChannelRoomsPage";
import WorkspaceConnectorsPage from "../pages/workspace/WorkspaceConnectorsPage";
import WorkspaceGeneralPage from "../pages/workspace/WorkspaceGeneralPage";
import WorkspaceUsersPage from "../pages/workspace/WorkspaceUsersPage";

/** Every page the signed-in dashboard has, in one table: its URL and who
 * may open it. The routes, their guards, the rail and the settings menus are
 * all built from it, so a page cannot be reachable by URL and hidden from the
 * nav, or the other way round.
 *
 * A page that moved keeps a redirect from its old URL, so a link from an
 * older Switch Console, the docs or a bookmark still lands on it.
 *
 * Every `path` here must also be in `PAGE_PATHS` (`core/switch_core/gateway/
 * ui.py`), which says what switch-core serves the dashboard for on a reload;
 * `test_gateway_ui.py` holds the two equal. */

export interface PageRoute {
  kind: "page";
  path: string;
  access: Rule;
  element: ReactNode;
  /** The settings area the page sits in, with its label in that area's menu. */
  area?: SettingsArea;
  menu?: string;
  /** About the person rather than the area, so its menu row sits apart. */
  personal?: true;
}

/** An area's own URL, which opens the page last used there. */
export interface AreaRoute {
  kind: "area";
  path: string;
  area: SettingsArea;
}

export interface RedirectRoute {
  kind: "redirect";
  path: string;
  to: string;
}

export type AppRoute = PageRoute | AreaRoute | RedirectRoute;

export interface AreaDefinition {
  title: string;
  access: Rule;
  /** Where the area opens when no remembered page may be used. */
  first: string;
  /** A place of its own, reaching past the current workspace: no rail
   * there, and the top bar leads back to the workspace. */
  outsideWorkspace: boolean;
}

export const AREAS: Record<SettingsArea, AreaDefinition> = {
  workspace: {
    title: "Workspace settings",
    access: everyone,
    first: "/settings/general",
    outsideWorkspace: false,
  },
  organization: {
    title: "Organization settings",
    access: organizationAdmins,
    first: "/settings/org/general",
    outsideWorkspace: true,
  },
  platform: {
    title: "Platform",
    access: operators,
    first: "/platform/workspaces",
    outsideWorkspace: true,
  },
};

function page(path: string, access: Rule, element: ReactNode): PageRoute {
  return { kind: "page", path, access, element };
}

function settingsPage(
  path: string,
  area: SettingsArea,
  menu: string,
  access: Rule,
  element: ReactNode,
): PageRoute {
  return { kind: "page", path, access, element, area, menu };
}

/** A page about the signed-in person, listed in the workspace settings menu
 * below the area's own pages, in a group of its own. */
function personalSettingsPage(
  path: string,
  menu: string,
  access: Rule,
  element: ReactNode,
): PageRoute {
  return { ...settingsPage(path, "workspace", menu, access, element), personal: true };
}

function areaIndex(path: string, area: SettingsArea): AreaRoute {
  return { kind: "area", path, area };
}

function redirect(path: string, to: string): RedirectRoute {
  return { kind: "redirect", path, to };
}

const orgConnectors = allOf(organizationAdminsOnly, serviceConnections, organizationConnectorApps);

export const ROUTES: readonly AppRoute[] = [
  redirect("/", "/overview"),
  page("/overview", everyone, <OverviewPage />),

  page("/ecosystem", everyone, <EcosystemGraphPage />),
  page("/rooms", everyone, <RoomsPage />),
  page("/rooms/new", everyone, <CreateRoomPage />),
  page("/rooms/groups", everyone, <GroupsPage />),
  page("/rooms/graph", everyone, <RoomsGraphPage />),
  page("/rooms/:roomId", everyone, <RoomDetailPage />),
  page("/rooms/:roomId/documents/:documentId", everyone, <RoomScopedDocumentView />),

  page("/resources", everyone, <ResourcesPage />),
  page("/resources/references/:id", everyone, <ReferenceDetailPage />),
  page("/resources/documents/:id", everyone, <DocumentDetailPage />),
  page("/resources/packages/:id", everyone, <PackageDetailPage />),
  redirect("/resources/templates/:id", "/templates/:id"),
  page("/templates", everyone, <TemplatesPage />),
  page("/templates/:id", everyone, <TemplateDetailPage />),

  page("/agents", everyone, <AgentListPage />),
  page("/agents/:agentId", everyone, <AgentDetailPage />),

  // Everyone's connector catalogue. The operator's server-wide connector
  // apps, which this URL once was, are under Platform.
  page("/connectors", serviceConnections, <ConnectorsPage />),
  page("/connectors/:connectorId", serviceConnections, <ConnectorPage />),

  page("/workspace/private-channel-rooms", workspaceAdmins, <PrivateChannelRoomsPage />),

  // Where the pages were before the settings areas.
  redirect("/machines", "/settings/devices"),
  redirect("/collaborations", "/settings/messaging-apps"),
  redirect("/registration-keys", "/settings/api-keys"),
  redirect("/workspace", "/settings/users"),
  redirect("/organization", "/settings/org"),
  redirect("/users", "/platform/users"),
  redirect("/operator/workspaces", "/platform/workspaces"),

  // Workspace settings. `/usage` keeps its URL until Usage & budget is
  // rebuilt, and sits here in the meantime.
  areaIndex("/settings", "workspace"),
  settingsPage("/settings/general", "workspace", "General", everyone, <WorkspaceGeneralPage />),
  settingsPage("/settings/users", "workspace", "Users", everyone, <WorkspaceUsersPage />),
  settingsPage(
    "/settings/messaging-apps",
    "workspace",
    "Messaging apps",
    everyone,
    <MessagingAppsPage />,
  ),
  settingsPage(
    "/settings/connectors",
    "workspace",
    "Connectors",
    serviceConnections,
    <WorkspaceConnectorsPage />,
  ),
  settingsPage("/settings/api-keys", "workspace", "API keys", everyone, <ApiKeysPage />),
  settingsPage("/settings/guardrails", "workspace", "Guardrails", everyone, <WorkspaceGuardrailsPage />),
  settingsPage("/settings/devices", "workspace", "Devices", agentManagement, <DevicesPage />),
  settingsPage("/usage", "workspace", "Usage & budget", workspaceAdmins, <UsagePage />),
  personalSettingsPage("/settings/account", "Your account", everyone, <AccountPage />),

  // Organization settings: the area admits the organization's admins, and
  // the operator to restore one; its pages beyond that are the admins' alone.
  areaIndex("/settings/org", "organization"),
  settingsPage(
    "/settings/org/general",
    "organization",
    "General",
    everyone,
    <OrganizationGeneralPage />,
  ),
  settingsPage(
    "/settings/org/workspaces",
    "organization",
    "Workspaces",
    everyone,
    <OrganizationWorkspacesPage />,
  ),
  settingsPage("/settings/org/users", "organization", "Users", everyone, <OrganizationUsersPage />),
  settingsPage(
    "/settings/org/connectors",
    "organization",
    "Connectors and apps",
    orgConnectors,
    <OrganizationConnectorsPage />,
  ),
  settingsPage(
    "/settings/org/guardrails",
    "organization",
    "Guardrails",
    organizationAdminsOnly,
    <OrganizationGuardrailsPage />,
  ),
  settingsPage(
    "/settings/org/devices",
    "organization",
    "Devices",
    allOf(organizationAdminsOnly, agentManagement),
    <OrganizationDevicesPage />,
  ),
  settingsPage(
    "/settings/org/audit-log",
    "organization",
    "Audit log",
    organizationAdminsOnly,
    <OrganizationAuditLogPage />,
  ),

  // The platform operator's pages. Each holds the operator rule itself, not
  // only through the area, so a page moved out of it stays the operator's.
  areaIndex("/platform", "platform"),
  settingsPage(
    "/platform/workspaces",
    "platform",
    "All workspaces",
    operators,
    <OperatorWorkspacesPage />,
  ),
  settingsPage("/platform/users", "platform", "Users", operators, <UsersPage />),
  settingsPage("/platform/connectors", "platform", "Connectors", operators, <ConnectorAppsPage />),
];

/** Whether `path` (a page's own URL, not a pattern) may be opened: its
 * area's rule and its own. A URL that is no page, or only a redirect, is
 * not. */
export function accessTo(path: string, caps: Capabilities): Access | null {
  const route = ROUTES.find((r) => r.path === path && r.kind !== "redirect");
  if (route === undefined || route.kind === "redirect") return null;
  if (route.kind === "area") return AREAS[route.area].access(caps);
  return route.area === undefined
    ? route.access(caps)
    : allOf(AREAS[route.area].access, route.access)(caps);
}

/** The settings area `pathname` (a page's own URL) is in, or null when it is
 * in none. */
export function areaOf(pathname: string): SettingsArea | null {
  for (const route of ROUTES) {
    if (route.kind === "redirect" || route.path !== pathname) continue;
    return route.area ?? null;
  }
  return null;
}

/** Whether `pathname` is in an area outside the workspace. */
export function outsideWorkspace(pathname: string): boolean {
  const area = areaOf(pathname);
  return area !== null && AREAS[area].outsideWorkspace;
}

/** The pages of `area`'s menu that `caps` may open, in order. */
export function menuOf(
  area: SettingsArea,
  caps: Capabilities,
): { label: string; path: string; personal: boolean }[] {
  return ROUTES.filter(
    (r): r is PageRoute & { menu: string } =>
      r.kind === "page" && r.area === area && r.menu !== undefined,
  )
    .filter((r) => r.access(caps).allowed)
    .map((r) => ({ label: r.menu, path: r.path, personal: r.personal === true }));
}

export interface RailItem {
  label: string;
  to: string;
  icon: ComponentType<{ sx?: object }>;
  /** The paths under which the item shows as the current one. */
  activeFor: readonly string[];
  /** Kept at the foot of the rail, beside the account button: an area for
   * settings rather than for work. */
  bottom: boolean;
}

function railItem(
  label: string,
  to: string,
  icon: ComponentType<{ sx?: object }>,
  { activeFor = [to], bottom = false }: { activeFor?: readonly string[]; bottom?: boolean } = {},
): RailItem {
  return { label, to, icon, activeFor, bottom };
}

/** The rail, in order. An item shows only to someone who may open the page
 * it leads to (`accessTo`). The ecosystem graph is opened from Overview,
 * which shows as current there. */
export const RAIL: readonly RailItem[] = [
  railItem("Overview", "/overview", DashboardOutlined, {
    activeFor: ["/overview", "/ecosystem"],
  }),
  railItem("Agents", "/agents", SmartToyOutlined),
  railItem("Rooms", "/rooms", MeetingRoomOutlined),
  railItem("Templates", "/templates", DescriptionOutlined),
  railItem("Connectors", "/connectors", PowerOutlined),
  railItem("Resources", "/resources", FolderOutlined),
  railItem("Settings", "/settings", SettingsOutlined, {
    activeFor: ["/settings", "/usage"],
    bottom: true,
  }),
  railItem("Platform", "/platform", AdminPanelSettingsOutlined, { bottom: true }),
];

export function railFor(caps: Capabilities): RailItem[] {
  return RAIL.filter((item) => accessTo(item.to, caps)?.allowed === true);
}
