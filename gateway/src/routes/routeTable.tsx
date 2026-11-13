import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import AdminPanelSettingsOutlined from "@mui/icons-material/AdminPanelSettingsOutlined";
import ApartmentOutlined from "@mui/icons-material/ApartmentOutlined";
import ChatBubbleOutlineOutlined from "@mui/icons-material/ChatBubbleOutlineOutlined";
import ComputerOutlined from "@mui/icons-material/ComputerOutlined";
import DashboardOutlined from "@mui/icons-material/DashboardOutlined";
import DataUsageOutlined from "@mui/icons-material/DataUsageOutlined";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import DnsOutlined from "@mui/icons-material/DnsOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import MeetingRoomOutlined from "@mui/icons-material/MeetingRoomOutlined";
import PeopleOutlined from "@mui/icons-material/PeopleOutlined";
import PowerOutlined from "@mui/icons-material/PowerOutlined";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import VpnKeyOutlined from "@mui/icons-material/VpnKeyOutlined";
import WorkspacesOutlined from "@mui/icons-material/WorkspacesOutlined";
import type { ComponentType, ReactNode } from "react";
import {
  type Access,
  type Capabilities,
  type Rule,
  agentManagement,
  allOf,
  everyone,
  inOrganization,
  operators,
  organizationAdmins,
  organizationAdminsOnly,
  organizationConnectorApps,
  serviceConnections,
  workspaceAdmins,
} from "../data/capabilities";
import type { SettingsArea } from "../data/settingsLanding";
import AgentDetailPage from "../pages/agents/AgentDetailPage";
import AgentListPage from "../pages/agents/AgentListPage";
import AgentsPage from "../pages/agents/AgentsPage";
import CollaborationsPage from "../pages/collaborations/CollaborationsPage";
import ConnectorAppsPage from "../pages/connector-apps/ConnectorAppsPage";
import EcosystemGraphPage from "../pages/ecosystem/EcosystemGraphPage";
import MachinesPage from "../pages/machines/MachinesPage";
import MessagingAppsPage from "../pages/messaging-apps/MessagingAppsPage";
import OperatorWorkspacesPage from "../pages/operator/OperatorWorkspacesPage";
import ConnectorPage from "../pages/connectors/ConnectorPage";
import OrganizationPage, {
  OrganizationAuditLogPage,
  OrganizationConnectorsPage,
  OrganizationGeneralPage,
  OrganizationGuardrailsPage,
  OrganizationUsersPage,
  OrganizationWorkspacesPage,
} from "../pages/organization/OrganizationPage";
import OverviewPage from "../pages/overview/OverviewPage";
import RegistrationKeysPage from "../pages/registration-keys/RegistrationKeysPage";
import DocumentDetailPage from "../pages/resources/DocumentDetailPage";
import PackageDetailPage from "../pages/resources/PackageDetailPage";
import ReferenceDetailPage from "../pages/resources/ReferenceDetailPage";
import ResourcesPage from "../pages/resources/ResourcesPage";
import TemplateDetailPage from "../pages/resources/TemplateDetailPage";
import CreateRoomPage from "../pages/rooms/CreateRoomPage";
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
import WorkspacePage, { WorkspaceGeneralPage } from "../pages/workspace/WorkspacePage";
import WorkspaceUsersPage from "../pages/workspace/WorkspaceUsersPage";
import { PlannedPage } from "./StatusPages";

/** Every page the signed-in dashboard has, in one table: its URL, who may
 * open it, and which layout it belongs to. The routes, their guards, the
 * rail and the settings menus are all built from it, so a page cannot be
 * reachable by URL and hidden from the nav, or the other way round.
 *
 * Two layouts live side by side while the new one is built: `current`, what
 * a server shows today, and `v2`, behind the `gateway_v2` flag. A page that
 * moved has a redirect in each: from its old URL in `v2`, and back from its
 * new one in `current`, so a link from Console or the docs works on a server
 * with the flag either way.
 *
 * Every `path` here must also be in `PAGE_PATHS` (`core/switch_core/gateway/
 * ui.py`), which says what switch-core serves the dashboard for on a reload;
 * `test_gateway_ui.py` holds the two equal. */

export type Layout = "current" | "v2";

const BOTH: readonly Layout[] = ["current", "v2"];
const CURRENT: readonly Layout[] = ["current"];
const V2: readonly Layout[] = ["v2"];

export interface PageRoute {
  kind: "page";
  path: string;
  layouts: readonly Layout[];
  access: Rule;
  element: ReactNode;
  /** The settings area the page sits in, with its label in that area's menu. */
  area?: SettingsArea;
  menu?: string;
}

/** An area's own URL, which opens the page last used there. */
export interface AreaRoute {
  kind: "area";
  path: string;
  layouts: readonly Layout[];
  area: SettingsArea;
}

export interface RedirectRoute {
  kind: "redirect";
  path: string;
  layouts: readonly Layout[];
  to: string;
}

export type AppRoute = PageRoute | AreaRoute | RedirectRoute;

export interface AreaDefinition {
  title: string;
  access: Rule;
  /** Where the area opens when no remembered page may be used. */
  first: string;
}

export const AREAS: Record<SettingsArea, AreaDefinition> = {
  workspace: { title: "Workspace settings", access: everyone, first: "/settings/general" },
  organization: {
    title: "Organization settings",
    access: organizationAdmins,
    first: "/settings/org/general",
  },
  platform: { title: "Platform", access: operators, first: "/platform/workspaces" },
};

function page(
  path: string,
  layouts: readonly Layout[],
  access: Rule,
  element: ReactNode,
): PageRoute {
  return { kind: "page", path, layouts, access, element };
}

function settingsPage(
  path: string,
  area: SettingsArea,
  menu: string,
  access: Rule,
  element: ReactNode,
): PageRoute {
  return { kind: "page", path, layouts: V2, access, element, area, menu };
}

function areaIndex(path: string, area: SettingsArea): AreaRoute {
  return { kind: "area", path, layouts: V2, area };
}

function redirect(path: string, layouts: readonly Layout[], to: string): RedirectRoute {
  return { kind: "redirect", path, layouts, to };
}

const orgConnectors = allOf(organizationAdminsOnly, serviceConnections, organizationConnectorApps);

export const ROUTES: readonly AppRoute[] = [
  redirect("/", CURRENT, "/rooms"),
  redirect("/", V2, "/overview"),
  page("/overview", V2, everyone, <OverviewPage />),
  redirect("/overview", CURRENT, "/"),

  page("/ecosystem", BOTH, everyone, <EcosystemGraphPage />),
  page("/rooms", BOTH, everyone, <RoomsPage />),
  page("/rooms/new", BOTH, everyone, <CreateRoomPage />),
  page("/rooms/groups", BOTH, everyone, <GroupsPage />),
  page("/rooms/graph", BOTH, everyone, <RoomsGraphPage />),
  page("/rooms/:roomId", BOTH, everyone, <RoomDetailPage />),
  page("/rooms/:roomId/documents/:documentId", BOTH, everyone, <RoomScopedDocumentView />),

  page("/resources", CURRENT, everyone, <ResourcesPage withTemplates />),
  page("/resources", V2, everyone, <ResourcesPage withTemplates={false} />),
  page("/resources/references/:id", BOTH, everyone, <ReferenceDetailPage />),
  page("/resources/documents/:id", BOTH, everyone, <DocumentDetailPage />),
  page("/resources/packages/:id", BOTH, everyone, <PackageDetailPage />),
  page("/resources/templates/:id", CURRENT, everyone, <TemplateDetailPage />),
  redirect("/resources/templates/:id", V2, "/templates/:id"),
  page("/templates", V2, everyone, <TemplatesPage />),
  redirect("/templates", CURRENT, "/resources?tab=templates"),
  page("/templates/:id", V2, everyone, <TemplateDetailPage />),
  redirect("/templates/:id", CURRENT, "/resources/templates/:id"),

  page("/agents", CURRENT, everyone, <AgentsPage />),
  page("/agents", V2, everyone, <AgentListPage />),
  page("/agents/:agentId", BOTH, everyone, <AgentDetailPage />),

  // Today `/connectors` is the operator's server-wide connector apps. In the
  // new layout it is everyone's connector catalogue, and the operator's page
  // moves to the Platform area.
  page("/connectors", CURRENT, operators, <ConnectorAppsPage />),
  page("/connectors", V2, serviceConnections, <PlannedPage title="Connectors" />),
  page("/connectors/:connectorId", V2, serviceConnections, <ConnectorPage />),

  page("/machines", CURRENT, agentManagement, <MachinesPage />),
  redirect("/machines", V2, "/settings/devices"),
  page("/collaborations", CURRENT, everyone, <CollaborationsPage />),
  redirect("/collaborations", V2, "/settings/messaging-apps"),
  page("/registration-keys", CURRENT, everyone, <RegistrationKeysPage />),
  redirect("/registration-keys", V2, "/settings/api-keys"),
  page("/workspace", CURRENT, everyone, <WorkspacePage />),
  page(
    "/workspace/private-channel-rooms",
    BOTH,
    workspaceAdmins,
    <PrivateChannelRoomsPage />,
  ),
  redirect("/workspace", V2, "/settings/users"),
  page("/organization", CURRENT, inOrganization, <OrganizationPage />),
  redirect("/organization", V2, "/settings/org"),
  page("/usage", CURRENT, workspaceAdmins, <UsagePage />),
  page("/users", CURRENT, operators, <UsersPage />),
  redirect("/users", V2, "/platform/users"),
  page("/operator/workspaces", CURRENT, operators, <OperatorWorkspacesPage />),
  redirect("/operator/workspaces", V2, "/platform/workspaces"),

  // Workspace settings. `/usage` keeps its URL until Usage & budget is
  // rebuilt, and sits here in the meantime.
  areaIndex("/settings", "workspace"),
  redirect("/settings", CURRENT, "/workspace"),
  settingsPage("/settings/general", "workspace", "General", everyone, <WorkspaceGeneralPage />),
  redirect("/settings/general", CURRENT, "/workspace"),
  settingsPage("/settings/users", "workspace", "Users", everyone, <WorkspaceUsersPage />),
  redirect("/settings/users", CURRENT, "/workspace"),
  settingsPage(
    "/settings/messaging-apps",
    "workspace",
    "Messaging apps",
    everyone,
    <MessagingAppsPage />,
  ),
  redirect("/settings/messaging-apps", CURRENT, "/collaborations"),
  settingsPage(
    "/settings/connectors",
    "workspace",
    "Connectors",
    serviceConnections,
    <WorkspaceConnectorsPage />,
  ),
  settingsPage("/settings/api-keys", "workspace", "API keys", everyone, <RegistrationKeysPage />),
  redirect("/settings/api-keys", CURRENT, "/registration-keys"),
  settingsPage(
    "/settings/guardrails",
    "workspace",
    "Guardrails",
    everyone,
    <PlannedPage title="Guardrails" />,
  ),
  settingsPage("/settings/devices", "workspace", "Devices", agentManagement, <MachinesPage />),
  redirect("/settings/devices", CURRENT, "/machines"),
  settingsPage("/usage", "workspace", "Usage & budget", workspaceAdmins, <UsagePage />),
  settingsPage(
    "/settings/account",
    "workspace",
    "Your account",
    everyone,
    <PlannedPage title="Your account" />,
  ),

  // Organization settings: the area admits the organization's admins, and
  // the operator to restore one; its pages beyond that are the admins' alone.
  areaIndex("/settings/org", "organization"),
  redirect("/settings/org", CURRENT, "/organization"),
  settingsPage(
    "/settings/org/general",
    "organization",
    "General",
    everyone,
    <OrganizationGeneralPage />,
  ),
  redirect("/settings/org/general", CURRENT, "/organization"),
  settingsPage(
    "/settings/org/workspaces",
    "organization",
    "Workspaces",
    everyone,
    <OrganizationWorkspacesPage />,
  ),
  redirect("/settings/org/workspaces", CURRENT, "/organization"),
  settingsPage("/settings/org/users", "organization", "Users", everyone, <OrganizationUsersPage />),
  redirect("/settings/org/users", CURRENT, "/organization"),
  settingsPage(
    "/settings/org/connectors",
    "organization",
    "Connectors and apps",
    orgConnectors,
    <OrganizationConnectorsPage />,
  ),
  redirect("/settings/org/connectors", CURRENT, "/organization"),
  settingsPage(
    "/settings/org/guardrails",
    "organization",
    "Guardrails",
    organizationAdminsOnly,
    <OrganizationGuardrailsPage />,
  ),
  redirect("/settings/org/guardrails", CURRENT, "/organization"),
  settingsPage(
    "/settings/org/devices",
    "organization",
    "Devices",
    organizationAdminsOnly,
    <PlannedPage title="Devices" />,
  ),
  settingsPage(
    "/settings/org/audit-log",
    "organization",
    "Audit log",
    organizationAdminsOnly,
    <OrganizationAuditLogPage />,
  ),
  redirect("/settings/org/audit-log", CURRENT, "/organization"),

  // The platform operator's pages.
  areaIndex("/platform", "platform"),
  redirect("/platform", CURRENT, "/operator/workspaces"),
  settingsPage(
    "/platform/workspaces",
    "platform",
    "All workspaces",
    everyone,
    <OperatorWorkspacesPage />,
  ),
  redirect("/platform/workspaces", CURRENT, "/operator/workspaces"),
  settingsPage("/platform/users", "platform", "Users", everyone, <UsersPage />),
  redirect("/platform/users", CURRENT, "/users"),
  settingsPage("/platform/connectors", "platform", "Connectors", everyone, <ConnectorAppsPage />),
  redirect("/platform/connectors", CURRENT, "/connectors"),
];

export function routesFor(layout: Layout): AppRoute[] {
  return ROUTES.filter((route) => route.layouts.includes(layout));
}

/** Whether `path` (a page's own URL, not a pattern) may be opened in
 * `layout`: its area's rule and its own. A URL that is no page there, or only
 * a redirect, is not. */
export function accessTo(path: string, layout: Layout, caps: Capabilities): Access | null {
  const route = routesFor(layout).find((r) => r.path === path && r.kind !== "redirect");
  if (route === undefined || route.kind === "redirect") return null;
  if (route.kind === "area") return AREAS[route.area].access(caps);
  return route.area === undefined
    ? route.access(caps)
    : allOf(AREAS[route.area].access, route.access)(caps);
}

/** The settings area `pathname` (a page's own URL) is in, in `layout`, or
 * null when it is in none. */
export function areaOf(pathname: string, layout: Layout): SettingsArea | null {
  for (const route of routesFor(layout)) {
    if (route.kind === "redirect" || route.path !== pathname) continue;
    return route.area ?? null;
  }
  return null;
}

/** The pages of `area`'s menu that `caps` may open, in order. */
export function menuOf(
  area: SettingsArea,
  layout: Layout,
  caps: Capabilities,
): { label: string; path: string }[] {
  return routesFor(layout)
    .filter(
      (r): r is PageRoute & { menu: string } =>
        r.kind === "page" && r.area === area && r.menu !== undefined,
    )
    .filter((r) => r.access(caps).allowed)
    .map((r) => ({ label: r.menu, path: r.path }));
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

/** The rail, in order, for each layout. An item shows only to someone who may
 * open the page it leads to (`accessTo`). */
export const RAIL: Record<Layout, readonly RailItem[]> = {
  current: [
    railItem("Ecosystem", "/ecosystem", AccountTreeOutlined),
    railItem("Rooms", "/rooms", MeetingRoomOutlined),
    railItem("Resources", "/resources", FolderOutlined),
    railItem("Agents", "/agents", SmartToyOutlined),
    railItem("Apps", "/collaborations", ChatBubbleOutlineOutlined),
    railItem("API keys", "/registration-keys", VpnKeyOutlined),
    railItem("Workspace", "/workspace", WorkspacesOutlined),
    railItem("Organization", "/organization", ApartmentOutlined),
    railItem("Devices", "/machines", ComputerOutlined),
    railItem("Usage", "/usage", DataUsageOutlined),
    railItem("All workspaces", "/operator/workspaces", DnsOutlined),
    railItem("Users", "/users", PeopleOutlined),
    railItem("Connectors", "/connectors", PowerOutlined),
  ],
  // The ecosystem graph is opened from Overview, which shows as current there.
  v2: [
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
  ],
};

export function railFor(layout: Layout, caps: Capabilities): RailItem[] {
  return RAIL[layout].filter((item) => accessTo(item.to, layout, caps)?.allowed === true);
}
