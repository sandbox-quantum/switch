import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { ConnectorAppsPage } from '@shared/core/switch-servers/dashboard-pages';

export type ConnectorCardKind =
  | 'coming_soon'
  | 'needs_setup'
  | 'unavailable'
  | 'workspace_off'
  | 'reconnect'
  | 'connected'
  | 'connect';

/**
 * What the person looking may fix: whoever {@link connectorAppSetUp} names
 * sets up the apps connectors sign in through; a workspace admin, or the
 * operator, turns a service on for the workspace.
 */
export type ConnectorViewer = {
  operator: boolean;
  administers: boolean;
  /** The server runs on this computer, so its own GitHub sign-in is at hand. */
  onThisComputer: boolean;
  appSetUp: ConnectorAppSetUp;
};

/**
 * Who sets up a connector's app. `viewer`: the person looking, in Console's
 * Admin › Apps or on a dashboard page. `organization-admin`: an admin of
 * their organization, on that dashboard page, because the server said the
 * person looking may not and its one organization's admins set the apps up.
 * `operator`: whoever runs the server. `command`: whoever runs the server,
 * with its command, because the server said the person looking may not and
 * the apps are not set up in its dashboard.
 */
export type ConnectorAppSetUp =
  | { by: 'viewer'; at: 'settings' | ConnectorAppsPage }
  | { by: 'organization-admin'; at: AnsweredAppsPage }
  | { by: 'operator' }
  | { by: 'command' };

/** The dashboard pages for connector apps on a server that says who sets them up. */
type AnsweredAppsPage = Exclude<ConnectorAppsPage, 'platform'>;

/**
 * {@link ConnectorAppSetUp} for the person looking. A server with a
 * dashboard says who may (`canManage`): its operator, or the admin of its one
 * organization, in either layout of the dashboard. To anyone else it says
 * whether its organization's admins set the apps up in the dashboard
 * (`inDashboard`) or the operator does with the command. Where it does not
 * say, or there is no dashboard (which leaves Admin › Apps), only the
 * operator may, and anyone else is told what they were before the server
 * could say.
 */
export function connectorAppSetUp({
  operator,
  servesDashboard,
  gatewayV2,
  canManage,
  inDashboard,
}: {
  operator: boolean;
  servesDashboard: boolean;
  gatewayV2: boolean;
  /** The server's `can_manage_connector_apps`; null where it does not say. */
  canManage: boolean | null;
  /** The server's `connector_apps_in_dashboard`; null where it does not say. */
  inDashboard: boolean | null;
}): ConnectorAppSetUp {
  const operatorOnly = (at: 'settings' | ConnectorAppsPage): ConnectorAppSetUp =>
    operator ? { by: 'viewer', at } : { by: 'operator' };
  if (!servesDashboard) return operatorOnly('settings');
  if (canManage === null) return operatorOnly(gatewayV2 ? 'platform' : 'old-layout');
  const at: AnsweredAppsPage = gatewayV2 ? 'organization-settings' : 'old-layout';
  if (canManage) return { by: 'viewer', at };
  if (inDashboard === true) return { by: 'organization-admin', at };
  if (inDashboard === false) return { by: 'command' };
  return gatewayV2 ? { by: 'command' } : { by: 'operator' };
}

/** Where an organization's admin sets the apps up, in words for the person sent to them. */
const ORGANIZATION_ADMIN_SETS_UP = {
  'organization-settings':
    'An admin of your organization sets it up in Organization settings › Connector apps.',
  'old-layout': 'An admin of your organization sets it up in the dashboard, under Connectors.',
} as const satisfies Record<AnsweredAppsPage, string>;

/** The one fix a card or profile offers: set the app up, or turn it on for the workspace. */
export type ConnectorFix = 'set_up' | 'turn_on';

export type ConnectorCardState = {
  kind: ConnectorCardKind;
  /** The card's badge. */
  label: string;
  /** Why, under the badge; null when the badge says it all. */
  detail: string | null;
  tone: 'muted' | 'problem' | 'good';
  /** What the person looking can do about it themselves; null when nothing. */
  fix: ConnectorFix | null;
};

export const FIX_LABEL = {
  set_up: 'Set up',
  turn_on: 'Turn on',
} as const satisfies Record<ConnectorFix, string>;

/** A service whose app is not set up, as {@link ConnectorAppSetUp} says who sets it up. */
function appNotSetUpState(
  entry: ConnectionCatalogEntry,
  setUp: ConnectorAppSetUp
): ConnectorCardState {
  switch (setUp.by) {
    case 'viewer':
      return {
        kind: 'needs_setup',
        label: 'Needs setup',
        detail: `Set up its app once, and everyone on this server can connect ${entry.name}.`,
        tone: 'muted',
        fix: 'set_up',
      };
    case 'organization-admin':
      return {
        kind: 'unavailable',
        label: 'Unavailable',
        detail: ORGANIZATION_ADMIN_SETS_UP[setUp.at],
        tone: 'muted',
        fix: null,
      };
    case 'command':
      return {
        kind: 'unavailable',
        label: 'Unavailable',
        detail:
          'Whoever runs your Switch server sets up its app with the switch-connector-apps command, where Switch runs.',
        tone: 'muted',
        fix: null,
      };
    case 'operator':
      return {
        kind: 'unavailable',
        label: 'Unavailable',
        detail: 'Ask whoever runs your Switch server to set it up.',
        tone: 'muted',
        fix: null,
      };
  }
}

/**
 * Why a service can't be used here, as the person looking acts on it. The
 * server's code decides it, never its wording: a server that sends no code
 * (one from before the codes) has its reason shown as it is.
 */
function unavailableState(
  entry: ConnectionCatalogEntry,
  reason: string,
  viewer: ConnectorViewer
): ConnectorCardState {
  const unavailable = { kind: 'unavailable', label: 'Unavailable', tone: 'muted' } as const;
  switch (entry.unavailable_code) {
    case 'app_not_set_up':
      return appNotSetUpState(entry, viewer.appSetUp);
    case 'needs_https':
      return {
        ...unavailable,
        detail:
          entry.slug === 'github' && viewer.onThisComputer
            ? "GitHub needs this server's address to be https, or http at localhost or 127.0.0.1, so it can't work on this one. Agents can use this computer's own GitHub sign-in (gh or git) instead."
            : `${entry.name} needs a server with an https address, or one on this computer, so it can't work on this one.`,
        fix: null,
      };
    case 'needs_public_url':
      return {
        ...unavailable,
        detail: viewer.operator
          ? `${entry.name} sends people back to this server's public address. Set GATEWAY_PUBLIC_URL, then restart Switch.`
          : `${entry.name} needs the server's public address. Ask whoever runs your Switch server to set it.`,
        fix: null,
      };
    default:
      return { ...unavailable, detail: reason, fix: null };
  }
}

/**
 * The one state a connector's card shows. When several apply, the first of
 * these wins: not built yet, not usable on this server (except an app that is
 * not set up yet waits on the workspace's switch first), switched off in this
 * workspace, needing a fresh sign-in, connected, and otherwise ready to
 * connect. A server without the workspace switch sends no
 * `workspace_enabled`, which reads as on. Where the person looking can fix
 * it themselves, the state names the fix. A connection to reconnect says why
 * in the server's words, where it gives them.
 */
export function connectorCardState(
  entry: ConnectionCatalogEntry,
  viewer: ConnectorViewer
): ConnectorCardState {
  if (entry.status === 'coming_soon')
    return { kind: 'coming_soon', label: 'Coming soon', detail: null, tone: 'muted', fix: null };
  const setUpLater =
    entry.unavailable_code === 'app_not_set_up' && entry.workspace_enabled === false;
  if (entry.unavailable_reason !== null && !setUpLater)
    return unavailableState(entry, entry.unavailable_reason, viewer);
  if (entry.workspace_enabled === false)
    return entry.organization_locked
      ? {
          kind: 'workspace_off',
          label: 'Off in this workspace',
          detail: 'Set by your organization.',
          tone: 'muted',
          fix: null,
        }
      : viewer.administers
        ? {
            kind: 'workspace_off',
            label: 'Off in this workspace',
            detail: 'Turn it on so people in this workspace can connect it.',
            tone: 'muted',
            fix: 'turn_on',
          }
        : {
            kind: 'workspace_off',
            label: 'Off in this workspace',
            detail: 'Ask a workspace admin to turn it on.',
            tone: 'muted',
            fix: null,
          };
  if (entry.status === 'needs_reauthorization')
    return {
      kind: 'reconnect',
      label: 'Reconnect needed',
      detail:
        entry.reconnect_reason ??
        `Switch can no longer use your ${entry.name} connection. Connect again.`,
      tone: 'problem',
      fix: null,
    };
  if (entry.status === 'connected')
    return { kind: 'connected', label: 'Connected', detail: null, tone: 'good', fix: null };
  // Connectable without its app (GitHub by pasted token): the operator is
  // offered to set the app up, so people can sign in too.
  if (viewer.operator && entry.server_setup_needed)
    return {
      kind: 'connect',
      label: 'Not connected',
      detail: `Set up its app so people can sign in to ${entry.name}, not only paste a token.`,
      tone: 'muted',
      fix: 'set_up',
    };
  return { kind: 'connect', label: 'Not connected', detail: null, tone: 'muted', fix: null };
}

/** The badge variant for a card's tone. */
export const TONE_BADGE = {
  problem: 'destructive',
  good: 'outline',
  muted: 'secondary',
} as const satisfies Record<ConnectorCardState['tone'], string>;
