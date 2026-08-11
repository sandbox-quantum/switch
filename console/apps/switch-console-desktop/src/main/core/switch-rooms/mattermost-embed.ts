import { session as electronSession } from 'electron';
import { LOCAL_SERVER_MATTERMOST_USER } from '@main/core/managed-switch-server/constants';
import { managedServerSecretsKey } from '@main/core/managed-switch-server/host/host-for-server';
import { loadOrCreateSecrets } from '@main/core/managed-switch-server/secrets';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { MattermostTheme } from '@shared/core/switch-rooms/mattermost-theme';
import {
  channelUrlFromDeeplink,
  mattermostPartition,
  type RoomEmbed,
} from '@shared/core/switch-rooms/room-embed';
import { mattermostOriginFor } from './mattermost-origin';

const MATTERMOST_AUTH_COOKIE = 'MMAUTHTOKEN';

/**
 * Log the shared `user` account into Mattermost so the webview's partition
 * holds a live session.
 *
 * Two things make this work, both verified against a real Mattermost 11.9.0
 * rather than reasoned about:
 *
 * 1. `X-Requested-With: XMLHttpRequest` is REQUIRED. Without it Mattermost
 *    answers 200 and returns a `Token` header but sets no cookies at all —
 *    cookie auth is deliberately granted only to XHR-style requests, since a
 *    cookie is what a cross-site form post could abuse. Its own web app always
 *    sends this header.
 * 2. The request must go through the partition's own session, which is where
 *    Electron then stores the response's cookies. A plain `net.fetch` puts
 *    them in the default session instead, out of the webview's reach.
 *
 * Mattermost marks only MMAUTHTOKEN HttpOnly; its web app reads MMUSERID and
 * MMCSRF from `document.cookie` to decide it is signed in, so all three must
 * land with their original flags. Letting the net stack store them keeps that
 * automatic.
 *
 * Throws on failure; an embed that silently renders a login page is worse than
 * a stated error.
 */
async function installMattermostSession(origin: string, serverId: string): Promise<string> {
  const server = await getServer(serverId);
  if (!server?.managed) throw new Error('Not a managed server');

  const secrets = await loadOrCreateSecrets({ secretsKey: managedServerSecretsKey(server) });

  const partition = mattermostPartition(serverId);
  const partitionSession = electronSession.fromPartition(partition);

  const response = await partitionSession.fetch(`${origin}/api/v4/users/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    credentials: 'include',
    body: JSON.stringify({
      login_id: LOCAL_SERVER_MATTERMOST_USER,
      password: secrets.mattermostUserPassword,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Mattermost login failed (${response.status}). The bundled chat may still be starting.`
    );
  }

  await partitionSession.cookies.flushStore();

  // Assert against the jar the webview reads, not the response — that is the
  // state the embed actually depends on.
  const stored = await partitionSession.cookies.get({ url: origin });
  const names = stored.map((c) => c.name);
  if (!names.includes(MATTERMOST_AUTH_COOKIE)) {
    throw new Error(
      `Mattermost login returned ${response.status} but the webview partition has no ` +
        `${MATTERMOST_AUTH_COOKIE} (cookies present: ${names.join(', ') || 'none'}).`
    );
  }

  return partition;
}

/**
 * Apply Switch Console's palette to the Mattermost account the embed signs in as.
 *
 * Mattermost stores this as a per-user preference, so it themes itself rather
 * than us overriding its stylesheet from the guest preload — menus, hovers and
 * code blocks stay coherent instead of half-converted.
 *
 * Best-effort: a room that renders in Mattermost's default colours is a
 * cosmetic problem, not a reason to fall back to the deeplink. Logged rather
 * than swallowed.
 */
async function applyMattermostTheme(
  origin: string,
  partition: string,
  theme: MattermostTheme
): Promise<void> {
  const partitionSession = electronSession.fromPartition(partition);
  const request = (path: string, init?: { method?: string; body?: string }) =>
    partitionSession.fetch(`${origin}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // Same requirement as the login: Mattermost rejects cookie-authenticated
        // writes that do not look like XHR.
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

  try {
    const meResponse = await request('/api/v4/users/me');
    if (!meResponse.ok) throw new Error(`GET /users/me returned ${meResponse.status}`);
    const { id } = (await meResponse.json()) as { id: string };

    // The preference value is a JSON *string*, not an object.
    const saved = await request(`/api/v4/users/${id}/preferences`, {
      method: 'PUT',
      body: JSON.stringify([
        { user_id: id, category: 'theme', name: '', value: JSON.stringify(theme) },
      ]),
    });
    if (!saved.ok) throw new Error(`PUT /preferences returned ${saved.status}`);
  } catch (cause) {
    log.warn('Could not apply the Switch Console theme to Mattermost; using its defaults', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Decide how to show a room's conversation, and prepare whatever that choice
 * needs (a logged-in partition, for the inline case).
 *
 * Every failure resolves to `external` or `unavailable` with a reason rather
 * than throwing: a room that cannot be embedded should degrade to its deeplink
 * with the cause on screen, not blank the pane.
 */
export async function resolveChannelEmbed(params: {
  serverId: string;
  bridgeType: string | null;
  externalChannelUrl: string | null;
  theme: MattermostTheme | null;
}): Promise<RoomEmbed> {
  const { serverId, bridgeType, externalChannelUrl, theme } = params;

  if (!bridgeType) {
    return {
      kind: 'unavailable',
      reason: 'This room has no chat channel — it was created as an agent-only room.',
    };
  }

  if (bridgeType !== 'mattermost') {
    if (externalChannelUrl) {
      return { kind: 'external', url: externalChannelUrl, platform: bridgeType };
    }
    return {
      kind: 'unavailable',
      reason: `This room is bridged to ${bridgeType}, which cannot be shown inside Switch Console.`,
    };
  }

  const origin = await mattermostOriginFor(serverId);
  if (!origin || !externalChannelUrl) {
    if (externalChannelUrl) {
      return { kind: 'external', url: externalChannelUrl, platform: bridgeType };
    }
    return {
      kind: 'unavailable',
      reason: 'No Mattermost channel is linked to this room yet.',
    };
  }

  const url = channelUrlFromDeeplink(externalChannelUrl, origin);
  if (!url) {
    return { kind: 'external', url: externalChannelUrl, platform: bridgeType };
  }

  try {
    const partition = await installMattermostSession(origin, serverId);
    if (theme) await applyMattermostTheme(origin, partition, theme);
    return { kind: 'inline', url, partition, chromeless: true };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    log.warn('Could not prepare inline Mattermost session; offering the deeplink instead', {
      serverId,
      reason,
    });
    return { kind: 'external', url: externalChannelUrl, platform: bridgeType };
  }
}
