import { filterConnections } from '@renderer/features/switch-servers/connections-filter';
import {
  FLAGS_NOT_READ_YET,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { ConnectorCardState, ConnectorFix } from './connector-card-state';

export type ConnectorsTab = 'yours' | 'discover';

/** Whether a service belongs on Yours: the person has a connection to it, working or not. */
export function isYours(entry: ConnectionCatalogEntry): boolean {
  return entry.status !== 'not_connected' && entry.status !== 'coming_soon';
}

/** The tab the page opens on: Yours once the person has a connection, Discover until then. */
export function defaultConnectorsTab(entries: readonly ConnectionCatalogEntry[]): ConnectorsTab {
  return entries.some(isYours) ? 'yours' : 'discover';
}

/**
 * The catalog cards a tab lists, narrowed by the search. Yours holds what the
 * person has connected; Discover holds the whole catalog, connected services
 * included, so a search there finds anything.
 */
export function connectorsInTab(
  entries: ConnectionCatalogEntry[],
  tab: ConnectorsTab,
  query: string
): ConnectionCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const inTab = entries.filter(
    (entry) =>
      (tab === 'discover' || isYours(entry)) &&
      (!needle ||
        [entry.name, entry.category, entry.description].some((text) =>
          text.toLocaleLowerCase().includes(needle)
        ))
  );
  return filterConnections(inTab, '');
}

/**
 * The card's own control, beside the part that opens the profile: the fix
 * its state offers the person looking (set the app up, turn it on for the
 * workspace), a way to connect where the profile would offer Connect, and a
 * mark (not a button) only when the card's one state is connected. A
 * connection the server or the workspace has made unusable shows that state
 * instead, and is still there to disconnect on the profile. Disconnecting
 * stays on the profile, so the grid can never remove anyone's access by a
 * stray click.
 */
export function cardQuickAction(
  entry: ConnectionCatalogEntry,
  state: ConnectorCardState
): 'connect' | 'connected' | ConnectorFix | null {
  if (state.fix !== null) return state.fix;
  if (state.kind === 'connected') return 'connected';
  return profileConnectAction(entry) === 'connect' && entry.connectable ? 'connect' : null;
}

/**
 * Whether the page is there at all. It is behind the server's
 * `service_connections` flag: with it off, the catalog route is not mounted,
 * so the page is absent rather than drawn empty. Until the flags have been
 * read it waits. Flags that could never be read are `unreadable`, which the
 * page says rather than reading them as off; once read, the last values read
 * stand while a later read fails.
 */
export function connectorsPageAccess(
  flags: ServerFeatureFlags | null
): 'loading' | 'absent' | 'shown' | 'unreadable' {
  if (flags === null || (flags.fetchedAt === null && flags.error === FLAGS_NOT_READ_YET))
    return 'loading';
  if (flags.fetchedAt === null) return 'unreadable';
  return flags.flags.service_connections ? 'shown' : 'absent';
}

/**
 * What the profile says and offers when the workspace has the service off: a
 * member is told who can switch it on; an admin is offered to switch it on.
 * Null when it is on, or the server has no workspace switch.
 */
export function workspaceOffNotice(
  entry: ConnectionCatalogEntry,
  administers: boolean
): { text: string; canEnable: boolean } | null {
  if (entry.workspace_enabled !== false) return null;
  return administers
    ? { text: `${entry.name} is switched off for this workspace.`, canEnable: true }
    : { text: 'Not enabled in this workspace. Ask a workspace admin.', canEnable: false };
}

/**
 * The profile's way to connect: connect, sign in again, (GitHub) choose
 * repositories, or replace a connected key. None while the workspace has the
 * service off, whose notice says what to do instead, nor where the server
 * says nothing can be connected until its app is set up, or ever on this
 * server, nor for a key Switch never hands to agents. Another reason the
 * server gives does not take it away: a service can often be connected where
 * it cannot be granted, and the button is disabled where it cannot.
 */
export function profileConnectAction(
  entry: ConnectionCatalogEntry
): 'connect' | 'reconnect' | 'replace' | null {
  if (entry.status === 'coming_soon' || entry.workspace_enabled === false) return null;
  if (
    entry.unavailable_code === 'app_not_set_up' ||
    entry.unavailable_code === 'needs_https' ||
    entry.unavailable_code === 'key_never_expires'
  )
    return null;
  if (entry.status === 'not_connected') return 'connect';
  if (entry.status === 'needs_reauthorization') return 'reconnect';
  return entry.auth_type === 'api_key' ? 'replace' : null;
}

/**
 * The profile header's line about the connection; null when there is none.
 * A key's line names no access level: Switch can't read what a key allows.
 */
export function connectedAsLine(entry: ConnectionCatalogEntry): string | null {
  if (entry.status === 'not_connected' || entry.status === 'coming_soon') return null;
  const access =
    entry.auth_type === 'api_key'
      ? null
      : entry.consent === 'write'
        ? 'Read and write'
        : entry.consent === 'read'
          ? 'Read'
          : null;
  const who =
    entry.auth_type === 'api_key'
      ? entry.external_identity
        ? `Connected with ${entry.external_identity}`
        : 'Connected with your key'
      : entry.external_identity
        ? `Connected as ${entry.external_identity}`
        : 'Connected';
  return access ? `${who} · ${access}` : who;
}

/** What agents can do with a key, for the profile's side column; null for a sign-in. */
export function keyAccessText(entry: ConnectionCatalogEntry): string | null {
  if (entry.auth_type !== 'api_key') return null;
  return `Whatever the key allows at ${entry.name}. Switch can't read a key's scopes.`;
}

/** How the service is connected, for the profile's side column. */
export function signInLabel(entry: ConnectionCatalogEntry): string {
  if (entry.slug === 'github') return 'GitHub App';
  return entry.auth_type === 'api_key' ? 'Key' : `Sign in at ${entry.name}`;
}

/** How long what an agent is handed lasts, for the profile's side column. */
export function tokenLifetimeLabel(entry: ConnectionCatalogEntry): string {
  if (entry.auth_type === 'api_key') return "The key itself, which doesn't expire";
  const seconds = entry.token_lifetime;
  if (seconds === null) return 'Not stated';
  if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute');
  if (seconds < 86_400) return plural(Math.round(seconds / 3600), 'hour');
  return plural(Math.round(seconds / 86_400), 'day');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
