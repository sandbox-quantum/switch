import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

export type ConnectorCardKind =
  | 'coming_soon'
  | 'unavailable'
  | 'workspace_off'
  | 'reconnect'
  | 'connected'
  | 'connect';

export type ConnectorCardState = {
  kind: ConnectorCardKind;
  /** The card's badge. */
  label: string;
  /** Why, under the badge; null when the badge says it all. */
  detail: string | null;
  tone: 'muted' | 'problem' | 'good';
};

/**
 * The one state a connector's card shows. When several apply, the first of
 * these wins: not built yet, not usable on this server (its reason is the
 * server's), switched off in this workspace, needing a fresh sign-in,
 * connected, and otherwise ready to connect. A server without the workspace
 * switch sends no `workspace_enabled`, which reads as on.
 */
export function connectorCardState(entry: ConnectionCatalogEntry): ConnectorCardState {
  if (entry.status === 'coming_soon')
    return { kind: 'coming_soon', label: 'Coming soon', detail: null, tone: 'muted' };
  if (entry.unavailable_reason !== null)
    return {
      kind: 'unavailable',
      label: 'Unavailable',
      detail: entry.unavailable_reason,
      tone: 'muted',
    };
  if (entry.workspace_enabled === false)
    return {
      kind: 'workspace_off',
      label: 'Off in this workspace',
      detail: 'A workspace admin has switched it off.',
      tone: 'muted',
    };
  if (entry.status === 'needs_reauthorization' || entry.status === 'error')
    return {
      kind: 'reconnect',
      label: entry.status === 'error' ? 'Connection failed' : 'Reconnect needed',
      detail: `Switch can no longer use your ${entry.name} connection. Connect again.`,
      tone: 'problem',
    };
  if (entry.status === 'connected')
    return { kind: 'connected', label: 'Connected', detail: null, tone: 'good' };
  return { kind: 'connect', label: 'Not connected', detail: null, tone: 'muted' };
}

/** The badge variant for a card's tone. */
export const TONE_BADGE = {
  problem: 'destructive',
  good: 'outline',
  muted: 'secondary',
} as const satisfies Record<ConnectorCardState['tone'], string>;
