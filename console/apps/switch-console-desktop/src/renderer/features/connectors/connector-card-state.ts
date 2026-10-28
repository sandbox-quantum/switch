import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

export type ConnectorCardKind =
  | 'coming_soon'
  | 'needs_setup'
  | 'unavailable'
  | 'workspace_off'
  | 'reconnect'
  | 'connected'
  | 'connect';

/**
 * What the person looking may fix, and where: the server's operator sets up
 * the apps connectors sign in through (Admin → Connector apps); a workspace
 * admin, or the operator, turns a service on for the workspace.
 */
export type ConnectorViewer = {
  operator: boolean;
  administers: boolean;
  /** The server runs on this computer, so its own GitHub sign-in is at hand. */
  onThisComputer: boolean;
};

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
      return viewer.operator
        ? {
            kind: 'needs_setup',
            label: 'Needs setup',
            detail: `Set up its app once, and everyone on this server can connect ${entry.name}.`,
            tone: 'muted',
            fix: 'set_up',
          }
        : {
            ...unavailable,
            detail: 'Ask whoever runs your Switch server to set it up.',
            fix: null,
          };
    case 'needs_https':
      return {
        ...unavailable,
        detail:
          entry.slug === 'github' && viewer.onThisComputer
            ? "GitHub needs a server with an https address, so it can't work on this one. Agents can use this computer's own GitHub sign-in (gh or git) instead."
            : `${entry.name} needs a server with an https address, so it can't work on this one.`,
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
 * these wins: not built yet, not usable on this server, switched off in this
 * workspace, needing a fresh sign-in, connected, and otherwise ready to
 * connect. A server without the workspace switch sends no
 * `workspace_enabled`, which reads as on. Where the person looking can fix
 * it themselves, the state names the fix.
 */
export function connectorCardState(
  entry: ConnectionCatalogEntry,
  viewer: ConnectorViewer
): ConnectorCardState {
  if (entry.status === 'coming_soon')
    return { kind: 'coming_soon', label: 'Coming soon', detail: null, tone: 'muted', fix: null };
  if (entry.unavailable_reason !== null)
    return unavailableState(entry, entry.unavailable_reason, viewer);
  if (entry.workspace_enabled === false)
    return viewer.administers
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
  if (entry.status === 'needs_reauthorization' || entry.status === 'error')
    return {
      kind: 'reconnect',
      label: entry.status === 'error' ? 'Connection failed' : 'Reconnect needed',
      detail: `Switch can no longer use your ${entry.name} connection. Connect again.`,
      tone: 'problem',
      fix: null,
    };
  if (entry.status === 'connected')
    return { kind: 'connected', label: 'Connected', detail: null, tone: 'good', fix: null };
  return { kind: 'connect', label: 'Not connected', detail: null, tone: 'muted', fix: null };
}

/** The badge variant for a card's tone. */
export const TONE_BADGE = {
  problem: 'destructive',
  good: 'outline',
  muted: 'secondary',
} as const satisfies Record<ConnectorCardState['tone'], string>;
