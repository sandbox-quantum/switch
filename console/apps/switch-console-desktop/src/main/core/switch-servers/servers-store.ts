import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import type { TelemetryEventMap } from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { db } from '@main/db/client';
import { agents, kv, type SwitchServerRow, switchServers } from '@main/db/schema';
import {
  urlOrigin,
  type AddServerParams,
  type ManagedServerRef,
  type RenameServerParams,
  type SwitchServer,
  type UpdateServerParams,
} from '@shared/core/switch-servers/switch-servers';

const ACTIVE_SERVER_KV_KEY = 'activeSwitchServerId';

function cookieSecretKey(serverId: string): string {
  return `switch-server-cookie:${serverId}`;
}

function mapRow(row: SwitchServerRow): SwitchServer {
  // A legacy managed row predating the discriminator has a null kind — read it
  // as `local`, the only managed kind that existed then.
  const managementKind = row.managed
    ? row.managementKind === 'remote'
      ? 'remote'
      : 'local'
    : null;
  return {
    id: row.id,
    name: row.name,
    gatewayUrl: row.gatewayUrl,
    apiUrl: row.apiUrl,
    managed: row.managed,
    managementKind,
    sshHost: row.sshHost ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Strip a trailing slash so `${url}/gateway` never doubles up. */
function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Find the registered server an agent endpoint belongs to, by matching the
 * endpoint's origin against each server's API (agent bridge) URL — the endpoint
 * an agent's `SWITCH_API_ENDPOINT` points at. Returns null when none matches.
 */
export async function findServerByEndpoint(endpoint: string): Promise<SwitchServer | null> {
  const target = urlOrigin(endpoint);
  if (!target) return null;
  const servers = await listServers();
  return servers.find((s) => urlOrigin(s.apiUrl) === target) ?? null;
}

export async function listServers(): Promise<SwitchServer[]> {
  const rows = await db.select().from(switchServers).orderBy(desc(switchServers.createdAt));
  return rows.map(mapRow);
}

export async function getServer(id: string): Promise<SwitchServer | null> {
  const [row] = await db.select().from(switchServers).where(eq(switchServers.id, id)).limit(1);
  return row ? mapRow(row) : null;
}

/** The single LOCAL managed server Switch Console runs on this machine, or null.
 * Legacy managed rows with no kind count as local. */
export async function getManagedServer(): Promise<SwitchServer | null> {
  const [row] = await db
    .select()
    .from(switchServers)
    .where(
      and(
        eq(switchServers.managed, true),
        // A null kind is a legacy local row; only 'remote' is excluded.
        or(isNull(switchServers.managementKind), ne(switchServers.managementKind, 'remote'))
      )
    )
    .limit(1);
  return row ? mapRow(row) : null;
}

/** The managed server Switch Console runs on a given remote host, or null. */
export async function getRemoteManagedServer(sshHost: string): Promise<SwitchServer | null> {
  const [row] = await db
    .select()
    .from(switchServers)
    .where(
      and(
        eq(switchServers.managed, true),
        eq(switchServers.managementKind, 'remote'),
        eq(switchServers.sshHost, sshHost)
      )
    )
    .limit(1);
  return row ? mapRow(row) : null;
}

/** Every server Switch Console runs itself (local + all remote hosts). */
export async function listManagedServers(): Promise<SwitchServer[]> {
  const rows = await db.select().from(switchServers).where(eq(switchServers.managed, true));
  return rows.map(mapRow);
}

/**
 * Upsert a managed server record for the given target (the single local stack,
 * or the stack on a specific remote host). Reuses the existing row for that
 * target if there is one (updating its URLs, which change when ports are
 * repicked), else adopts a row already at this gateway URL, else inserts. Keeps
 * exactly one row per managed target rather than duplicating on URL changes.
 */
export async function ensureManagedServer(
  params: AddServerParams,
  ref: ManagedServerRef
): Promise<SwitchServer> {
  const gatewayUrl = normaliseUrl(params.gatewayUrl);
  const apiUrl = normaliseUrl(params.apiUrl);
  const managementKind = ref.kind;
  const sshHost = ref.kind === 'remote' ? ref.sshHost : null;
  const existingForTarget =
    ref.kind === 'remote' ? await getRemoteManagedServer(ref.sshHost) : await getManagedServer();
  const existing = existingForTarget ?? (await getServerByGatewayUrl(gatewayUrl));
  if (existing) {
    // Preserve the stored name on restart: the name is set once at creation and
    // then owned by the user (rename). Only the URLs/kind refresh when a managed
    // stack restarts (ports can change), so overwriting name here would clobber a
    // rename — the local stack always restarts with a hardcoded default name.
    const [row] = await db
      .update(switchServers)
      .set({
        gatewayUrl,
        apiUrl,
        managed: true,
        managementKind,
        sshHost,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(switchServers.id, existing.id))
      .returning();
    return mapRow(row);
  }
  const [row] = await db
    .insert(switchServers)
    .values({
      id: randomUUID(),
      name: params.name.trim(),
      gatewayUrl,
      apiUrl,
      managed: true,
      managementKind,
      sshHost,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();
  // Only the insert: this function also runs on every restart of a stack that
  // already exists, and that is not a server being added.
  trackEvent('server_added', {
    server_kind: ref.kind === 'remote' ? 'remote_managed' : 'local',
    outcome: 'success',
  });
  return mapRow(row);
}

async function getServerByGatewayUrl(gatewayUrl: string): Promise<SwitchServer | null> {
  const [row] = await db
    .select()
    .from(switchServers)
    .where(eq(switchServers.gatewayUrl, gatewayUrl))
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function addServer(params: AddServerParams): Promise<SwitchServer> {
  const [row] = await db
    .insert(switchServers)
    .values({
      id: randomUUID(),
      name: params.name.trim(),
      gatewayUrl: normaliseUrl(params.gatewayUrl),
      apiUrl: normaliseUrl(params.apiUrl),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();
  // Not reported here, unlike the managed insert above: registering a URL is a
  // discrete action with one caller, so the controller reports both of its
  // outcomes together and a single Add cannot produce two events. The managed
  // kinds have no such single owner — two services call that path and so does
  // every restart — which is why it is reported at the insert instead.
  return mapRow(row);
}

export async function updateServer(params: UpdateServerParams): Promise<SwitchServer> {
  const [row] = await db
    .update(switchServers)
    .set({
      name: params.name.trim(),
      gatewayUrl: normaliseUrl(params.gatewayUrl),
      apiUrl: normaliseUrl(params.apiUrl),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(switchServers.id, params.id))
    .returning();
  if (!row) {
    throw new Error(`No Switch server with id ${params.id}`);
  }
  return mapRow(row);
}

export async function renameServer(params: RenameServerParams): Promise<SwitchServer> {
  const [row] = await db
    .update(switchServers)
    .set({ name: params.name.trim(), updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(switchServers.id, params.id))
    .returning();
  if (!row) {
    throw new Error(`No Switch server with id ${params.id}`);
  }
  return mapRow(row);
}

export async function removeServer(id: string): Promise<void> {
  // Read before the row goes, since nothing afterwards can say what kind it was
  // — but a read that exists only to describe the removal must not prevent it.
  const server = await getServer(id).catch(() => null);

  await deleteSessionCookie(id);
  // Unlink agents explicitly: SQLite's ALTER TABLE ADD COLUMN can't carry an
  // ON DELETE clause, so the FK's set-null isn't enforced by the engine.
  await db.update(agents).set({ serverId: null }).where(eq(agents.serverId, id));
  await db.delete(switchServers).where(eq(switchServers.id, id));
  if ((await getActiveServerId()) === id) {
    await db.delete(kv).where(eq(kv.key, ACTIVE_SERVER_KV_KEY));
  }

  // Removing an already-absent server is not a server being removed.
  if (server) trackEvent('server_removed', { server_kind: serverKindOf(server) });
}

/** The reported kind of a server, in the same terms `server_added` uses. */
export function serverKindOf(
  server: SwitchServer
): TelemetryEventMap['server_added']['server_kind'] {
  if (!server.managed) return 'external';
  return server.managementKind === 'remote' ? 'remote_managed' : 'local';
}

export async function getActiveServerId(): Promise<string | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, ACTIVE_SERVER_KV_KEY)).limit(1);
  return row?.value ?? null;
}

export async function setActiveServerId(id: string): Promise<void> {
  const server = await getServer(id);
  if (!server) {
    throw new Error(`No Switch server with id ${id}`);
  }
  await db
    .insert(kv)
    .values({ key: ACTIVE_SERVER_KV_KEY, value: id, updatedAt: sql`CURRENT_TIMESTAMP` })
    .onConflictDoUpdate({
      target: kv.key,
      set: { value: id, updatedAt: sql`CURRENT_TIMESTAMP` },
    });
}

// ---------------------------------------------------------------------------
// Session cookie (the gateway `switch_auth` JWT), stored encrypted — never in
// the servers table or plain settings.
// ---------------------------------------------------------------------------

export async function getSessionCookie(serverId: string): Promise<string | null> {
  return encryptedAppSecretsStore.readRecoverableSecret(cookieSecretKey(serverId));
}

export async function setSessionCookie(serverId: string, jwt: string): Promise<void> {
  await encryptedAppSecretsStore.setSecret(cookieSecretKey(serverId), jwt);
}

export async function deleteSessionCookie(serverId: string): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(cookieSecretKey(serverId));
}
