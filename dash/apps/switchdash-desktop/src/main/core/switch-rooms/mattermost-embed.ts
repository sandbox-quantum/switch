import { net, session as electronSession } from 'electron';
import {
  managedServerSecretsKey,
  managedServerStateDir,
} from '@main/core/managed-switch-server/host/host-for-server';
import { readPersistedPorts } from '@main/core/managed-switch-server/ports';
import { loadOrCreateSecrets } from '@main/core/managed-switch-server/secrets';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import {
  channelUrlFromDeeplink,
  mattermostPartition,
  type RoomEmbed,
} from '@shared/core/switch-rooms/room-embed';

const MATTERMOST_AUTH_COOKIE = 'MMAUTHTOKEN';
const MATTERMOST_USER = 'user';

/**
 * Where this server's Mattermost is reachable from the desktop, or null when we
 * don't run it. Only managed servers publish Mattermost on a port we chose and
 * hold credentials for; an external server's Mattermost (if any) is somebody
 * else's deployment.
 */
async function mattermostOriginFor(serverId: string): Promise<string | null> {
  const server = await getServer(serverId);
  if (!server?.managed) return null;

  const ports = await readPersistedPorts({ stateDir: managedServerStateDir(server) });
  if (!ports) return null;

  // Remote-managed stacks publish onto the SSH host's loopback and are reached
  // through the same forwarded ports the gateway URL already uses, so the
  // gateway's hostname is the right one to pair with the Mattermost port.
  const gatewayHost = new URL(server.gatewayUrl).hostname;
  return `http://${gatewayHost}:${ports.mattermost}`;
}

/**
 * Log the shared `user` account into Mattermost so the webview's partition
 * holds a live session.
 *
 * Mattermost issues three cookies on login and marks only MMAUTHTOKEN
 * HttpOnly: its web app reads MMUSERID and MMCSRF from `document.cookie` to
 * decide it is signed in, so a session missing those renders a login page
 * despite being valid. We therefore need the real cookies, not a reconstructed
 * one — and `Set-Cookie` is a forbidden response header under the Fetch spec,
 * so the response object cannot show them to us.
 *
 * So: let the net stack store them, then move them. Electron's `net.fetch`
 * writes cookies into the DEFAULT session's jar regardless of the session the
 * request was made on (electron#44456), so the login runs there and the
 * resulting cookies are copied into the partition with their flags intact and
 * cleared from the default jar afterwards, since an auth cookie for someone
 * else's server has no business outliving this call there.
 *
 * Throws on failure; an embed that silently renders a login page is worse than
 * a stated error.
 */
async function installMattermostSession(origin: string, serverId: string): Promise<string> {
  const server = await getServer(serverId);
  if (!server?.managed) throw new Error('Not a managed server');

  const secrets = await loadOrCreateSecrets({ secretsKey: managedServerSecretsKey(server) });

  const response = await net.fetch(`${origin}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      login_id: MATTERMOST_USER,
      password: secrets.mattermostUserPassword,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Mattermost login failed (${response.status}). The bundled chat may still be starting.`
    );
  }

  const partition = mattermostPartition(serverId);
  const partitionSession = electronSession.fromPartition(partition);
  const defaultJar = electronSession.defaultSession.cookies;

  const issued = await defaultJar.get({ url: origin });
  for (const cookie of issued) {
    await partitionSession.cookies.set({
      url: origin,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path ?? '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
    });
    await defaultJar.remove(origin, cookie.name);
  }
  await partitionSession.cookies.flushStore();

  // Assert against the jar the webview reads, not the response — that is the
  // state the embed actually depends on.
  const stored = await partitionSession.cookies.get({ url: origin });
  const names = stored.map((c) => c.name);
  if (!names.includes(MATTERMOST_AUTH_COOKIE)) {
    // Report both jars: "issued none" means the net stack never stored the
    // login's cookies anywhere, which is a different problem from a copy that
    // dropped them, and the two need different fixes.
    throw new Error(
      `Mattermost login succeeded but the webview partition has no ${MATTERMOST_AUTH_COOKIE}. ` +
        `Issued by login: ${issued.map((c) => c.name).join(', ') || 'none'}. ` +
        `In partition: ${names.join(', ') || 'none'}.`
    );
  }

  return partition;
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
}): Promise<RoomEmbed> {
  const { serverId, bridgeType, externalChannelUrl } = params;

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
      reason: `This room is bridged to ${bridgeType}, which cannot be shown inside switchdash.`,
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
