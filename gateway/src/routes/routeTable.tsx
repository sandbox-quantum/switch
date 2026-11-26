import ForumOutlined from "@mui/icons-material/ForumOutlined";
import HomeOutlined from "@mui/icons-material/HomeOutlined";
import LocalLibraryOutlined from "@mui/icons-material/LocalLibraryOutlined";
import MeetingRoomOutlined from "@mui/icons-material/MeetingRoomOutlined";
import PowerOutlined from "@mui/icons-material/PowerOutlined";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import ViewQuiltOutlined from "@mui/icons-material/ViewQuiltOutlined";
import { type ComponentType, type ReactNode, Suspense, lazy } from "react";
import {
  type Access,
  type Capabilities,
  type Rule,
  agentManagement,
  allOf,
  anyOf,
  connectorAppManagers,
  everyone,
  gatewayChats,
  gatewayOnboarding,
  messageRoutingManagers,
  organizationAdmins,
  organizationAdminsOnly,
  organizationConnectorApps,
  serviceConnections,
  workspaceAdmins,
} from "../data/capabilities";
import type { SettingsArea } from "../data/settingsLanding";
import AccountPage from "../pages/account/AccountPage";
import AgentDetailRedirect from "../pages/agents/AgentDetailRedirect";
import AgentDetailPage from "../pages/agents/AgentDetailPage";
import ApiKeysPage from "../pages/api-keys/ApiKeysPage";
import AgentListPage from "../pages/agents/AgentListPage";
import AIProvidersPage from "../pages/ai-providers/AIProvidersPage";
import ConnectorAppsPage from "../pages/connector-apps/ConnectorAppsPage";
import EcosystemGraphPage from "../pages/ecosystem/EcosystemGraphPage";
import MessagingAppsPage from "../pages/messaging-apps/MessagingAppsPage";
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
import WorkspaceGuardrailsPage from "../pages/guardrails/WorkspaceGuardrailsPage";
import CreateRoomPage from "../pages/rooms/CreateRoomPage";
import GroupsPage from "../pages/rooms/GroupsPage";
import RoomDetailRedirect from "../pages/rooms/RoomDetailRedirect";
import RoomDetailPage from "../pages/rooms/RoomDetailPage";
import RoomScopedDocumentView from "../pages/rooms/RoomScopedDocumentView";
import RoomsGraphPage from "../pages/rooms/RoomsGraphPage";
import RoomsPage from "../pages/rooms/RoomsPage";
import TemplatesPage from "../pages/templates/TemplatesPage";
import PrivateChannelRoomsPage from "../pages/workspace/PrivateChannelRoomsPage";
import WorkspaceConnectorsPage from "../pages/workspace/WorkspaceConnectorsPage";
import WorkspaceGeneralPage from "../pages/workspace/WorkspaceGeneralPage";
import WorkspaceUsersPage from "../pages/workspace/WorkspaceUsersPage";
import MessageRoutingPage from "../pages/workspace/MessageRoutingPage";

const GetStartedPage = lazy(() => import("../pages/get-started/GetStartedPage"));
const getStarted = (
  <Suspense fallback={null}>
    <GetStartedPage />
  </Suspense>
);

// The chat UI is loaded only when the page is opened.
const ChatsPage = lazy(() => import("../pages/chats/ChatsPage"));
const chats = (
  <Suspense fallback={null}>
    <ChatsPage />
  </Suspense>
);

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
  /** A redirect that holds only where `when` allows it; elsewhere the URL is
   * a page anyone may open, showing `otherwise`. */
  only?: { when: Rule; otherwise: ReactNode };
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
    title: "Settings",
    access: everyone,
    first: "/settings/general",
    outsideWorkspace: false,
  },
  organization: {
    title: "Organization settings",
    // Whoever may set up the deployment's connector apps comes in for them
    // even from a workspace in no organization, which an older release
    // could make; every other page here asks for the organization itself.
    access: anyOf(organizationAdmins, connectorAppManagers),
    first: "/settings/org/general",
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

/** A page of a settings area reached from one of its pages rather than its
 * menu: the area's chrome, with no menu row of its own. */
function withinArea(route: PageRoute, area: SettingsArea): PageRoute {
  return { ...route, area };
}

function areaIndex(path: string, area: SettingsArea): AreaRoute {
  return { kind: "area", path, area };
}

function redirect(path: string, to: string, only?: RedirectRoute["only"]): RedirectRoute {
  return { kind: "redirect", path, to, only };
}

const orgConnectors = allOf(organizationAdminsOnly, serviceConnections, organizationConnectorApps);

export const ROUTES: readonly AppRoute[] = [
  redirect("/", "/overview"),
  page("/overview", everyone, <OverviewPage />),

  page("/ecosystem", everyone, <EcosystemGraphPage />),
  page("/get-started", allOf(gatewayOnboarding, agentManagement), getStarted),
  page("/chats", gatewayChats, chats),
  page("/chats/agents/:agentId", gatewayChats, chats),
  page("/chats/rooms/:roomId", gatewayChats, chats),
  page("/chats/:roomId", gatewayChats, chats),
  // Where there are Chats, rooms are listed there and a new one is made in its
  // New room dialog; elsewhere the Rooms list and the New room page stay.
  redirect("/rooms", "/chats?tab=rooms", { when: gatewayChats, otherwise: <RoomsPage /> }),
  redirect("/rooms/new", "/chats?tab=rooms&new=room", {
    when: gatewayChats,
    otherwise: <CreateRoomPage />,
  }),
  redirect("/rooms/groups", "/settings/room-groups"),
  redirect("/rooms/graph", "/settings/room-graph"),
  page("/rooms/:roomId/manage", everyone, <RoomDetailPage />),
  page("/rooms/:roomId", everyone, <RoomDetailRedirect />),
  page("/rooms/:roomId/documents/:documentId", everyone, <RoomScopedDocumentView />),

  page("/resources", everyone, <ResourcesPage />),
  page("/resources/references/:id", everyone, <ReferenceDetailPage />),
  page("/resources/documents/:id", everyone, <DocumentDetailPage />),
  page("/resources/packages/:id", everyone, <PackageDetailPage />),
  redirect("/resources/templates/:id", "/templates/:id"),
  page("/templates", everyone, <TemplatesPage />),
  page("/templates/:id", everyone, <TemplateDetailPage />),

  page("/agents", everyone, <AgentListPage />),
  page("/agents/:agentId/manage", everyone, <AgentDetailPage />),
  page("/agents/:agentId", everyone, <AgentDetailRedirect />),

  // Everyone's connector catalogue. The deployment's connector apps, which
  // this URL once was, are in Organization settings, as Connector apps.
  page("/connectors", serviceConnections, <ConnectorsPage />),
  page("/connectors/:connectorId", serviceConnections, <ConnectorPage />),

  // Where the pages were before the settings areas.
  redirect("/machines", "/settings/devices"),
  redirect("/collaborations", "/settings/messaging-apps"),
  redirect("/registration-keys", "/settings/api-keys"),
  redirect("/workspace", "/settings/users"),
  redirect("/workspace/private-channel-rooms", "/settings/general/private-channel-rooms"),
  redirect("/organization", "/settings/org"),

  // The old URLs of the platform operator's own pages, which the dashboard no
  // longer has: accounts and organizations are managed with server commands.
  // Each leads to the nearest page there is.
  redirect("/users", "/settings/org/users"),
  redirect("/operator/workspaces", "/settings/org/workspaces"),
  redirect("/platform", "/settings/org/workspaces"),
  redirect("/platform/workspaces", "/settings/org/workspaces"),
  redirect("/platform/users", "/settings/org/users"),
  redirect("/platform/connectors", "/settings/org/connector-apps"),

  // Workspace settings.
  areaIndex("/settings", "workspace"),
  settingsPage("/settings/general", "workspace", "General", everyone, <WorkspaceGeneralPage />),
  // Opened from General's "Public rooms on private channels" warning.
  withinArea(
    page("/settings/general/private-channel-rooms", workspaceAdmins, <PrivateChannelRoomsPage />),
    "workspace",
  ),
  settingsPage("/settings/users", "workspace", "Users", everyone, <WorkspaceUsersPage />),
  settingsPage("/settings/room-groups", "workspace", "Room groups", everyone, <GroupsPage />),
  settingsPage("/settings/room-graph", "workspace", "Rooms graph", everyone, <RoomsGraphPage />),
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
  settingsPage("/settings/message-routing", "workspace", "Message routing", messageRoutingManagers, <MessageRoutingPage />),
  // Usage & budget (pages/usage) is off until it is offered.
  redirect("/usage", "/settings"),
  settingsPage("/settings/ai-providers", "workspace", "AI providers", agentManagement, <AIProvidersPage />),
  settingsPage("/settings/devices", "workspace", "Devices", agentManagement, <DevicesPage />),
  personalSettingsPage("/settings/account", "Your account", everyone, <AccountPage />),

  // Organization settings: the area admits the organization's admins, the
  // operator to restore one, and whoever may set up the deployment's
  // connector apps. Its pages beyond General, Workspaces and Users are the
  // admins' alone, but for Connector apps, which is whoever may set up the
  // deployment's connector apps, the operator included, in an organization
  // or not.
  areaIndex("/settings/org", "organization"),
  settingsPage(
    "/settings/org/general",
    "organization",
    "General",
    organizationAdmins,
    <OrganizationGeneralPage />,
  ),
  settingsPage(
    "/settings/org/workspaces",
    "organization",
    "Workspaces",
    organizationAdmins,
    <OrganizationWorkspacesPage />,
  ),
  settingsPage(
    "/settings/org/users",
    "organization",
    "Users",
    organizationAdmins,
    <OrganizationUsersPage />,
  ),
  settingsPage(
    "/settings/org/connectors",
    "organization",
    "Connectors",
    orgConnectors,
    <OrganizationConnectorsPage />,
  ),
  settingsPage(
    "/settings/org/connector-apps",
    "organization",
    "Connector apps",
    connectorAppManagers,
    <ConnectorAppsPage />,
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
];

/** Whether `path` (a page's own URL, not a pattern) may be opened: its
 * area's rule and its own. A URL that is no page, or only a redirect, is
 * not. */
export function accessTo(path: string, caps: Capabilities): Access | null {
  const route = ROUTES.find((r) => r.path === path && (r.kind !== "redirect" || r.only));
  if (route === undefined) return null;
  if (route.kind === "redirect") return route.only?.when(caps).allowed ? null : everyone(caps);
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

/** The settings area `pathname` (a page's own URL) is in, where `caps` may
 * enter it, or null. A refused area, or a URL that is no page, is shown in
 * the workspace's own chrome rather than the area's. */
export function enteredArea(pathname: string, caps: Capabilities): SettingsArea | null {
  const area = areaOf(pathname);
  return area !== null && AREAS[area].access(caps).allowed ? area : null;
}

/** Whether `pathname` is shown, to someone with `caps`, as a place outside
 * the workspace. */
export function outsideWorkspace(pathname: string, caps: Capabilities): boolean {
  const area = enteredArea(pathname, caps);
  return area !== null && AREAS[area].outsideWorkspace;
}

/** Whether `pathname` is under the URL of an area outside the workspace,
 * whether or not there is a page at it. */
export function underAreaOutsideWorkspace(pathname: string): boolean {
  return ROUTES.some(
    (route) =>
      route.kind === "area" &&
      AREAS[route.area].outsideWorkspace &&
      (pathname === route.path || pathname.startsWith(`${route.path}/`)),
  );
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
  /** Whether the label shows under the glyph. Unshown, it is still the
   * item's accessible name. */
  labelled: boolean;
}

function railItem(
  label: string,
  to: string,
  icon: ComponentType<{ sx?: object }>,
  {
    activeFor = [to],
    bottom = false,
    labelled = true,
  }: { activeFor?: readonly string[]; bottom?: boolean; labelled?: boolean } = {},
): RailItem {
  return { label, to, icon, activeFor, bottom, labelled };
}

/** The rail, in order. An item shows only to someone who may open the page
 * it leads to (`accessTo`). The ecosystem graph is opened from Home, which
 * shows as current there; where there are Chats, rooms are listed and opened
 * there, and Chats shows as current on their pages (Rooms, leading to a page
 * that is then a redirect, is left off); Get started opens on a first visit, and from Home. Each
 * glyph is the outline of the thing the page holds. The Settings cog needs no
 * label, like the account button below it. */
export const RAIL: readonly RailItem[] = [
  railItem("Home", "/overview", HomeOutlined, {
    activeFor: ["/overview", "/ecosystem"],
  }),
  railItem("Chats", "/chats", ForumOutlined, { activeFor: ["/chats", "/rooms"] }),
  railItem("Agents", "/agents", SmartToyOutlined),
  railItem("Rooms", "/rooms", MeetingRoomOutlined),
  railItem("Templates", "/templates", ViewQuiltOutlined),
  railItem("Connectors", "/connectors", PowerOutlined),
  railItem("Resources", "/resources", LocalLibraryOutlined),
  railItem("Settings", "/settings", SettingsOutlined, {
    activeFor: ["/settings", "/usage"],
    bottom: true,
    labelled: false,
  }),
];

/** The rail `caps` may use. */
export function railFor(caps: Capabilities): RailItem[] {
  return RAIL.filter((item) => accessTo(item.to, caps)?.allowed === true);
}
