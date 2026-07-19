import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { db } from '@main/db/client';
import { agents, kv, type SwitchServerRow, switchServers } from '@main/db/schema';
import type {
  AddServerParams,
  SwitchServer,
  UpdateServerParams,
} from '@shared/core/switch-servers/switch-servers';

const ACTIVE_SERVER_KV_KEY = 'activeSwitchServerId';

function cookieSecretKey(serverId: string): string {
  return `switch-server-cookie:${serverId}`;
}

function mapRow(row: SwitchServerRow): SwitchServer {
  return {
    id: row.id,
    name: row.name,
    gatewayUrl: row.gatewayUrl,
    apiUrl: row.apiUrl,
    managed: row.managed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Strip a trailing slash so `${url}/gateway` never doubles up. */
function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Origin (protocol + host + port, lowercased) of a URL, or null if unparseable.
 * Agents are matched to servers by origin rather than full URL: an agent's
 * `SWITCH_API_ENDPOINT` and a server's API URL share a host but may differ in
 * path, so comparing origins is the robust match.
 */
export function urlOrigin(url: string): string | null {
  try {
    return new URL(url.trim()).origin.toLowerCase();
  } catch {
    return null;
  }
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

/** The single server switchdash runs itself (local-server mode), or null. */
export async function getManagedServer(): Promise<SwitchServer | null> {
  const [row] = await db
    .select()
    .from(switchServers)
    .where(eq(switchServers.managed, true))
    .limit(1);
  return row ? mapRow(row) : null;
}

/**
 * Upsert the managed local server record by its gateway URL. If a record with
 * that URL already exists (e.g. the user had added localhost by hand) it is
 * adopted and flagged managed; otherwise a new managed record is created. The
 * gateway URL has a unique index, so keying on it avoids a duplicate-row clash.
 */
export async function ensureManagedServer(params: AddServerParams): Promise<SwitchServer> {
  const gatewayUrl = normaliseUrl(params.gatewayUrl);
  const apiUrl = normaliseUrl(params.apiUrl);
  const [existing] = await db
    .select()
    .from(switchServers)
    .where(eq(switchServers.gatewayUrl, gatewayUrl))
    .limit(1);
  if (existing) {
    const [row] = await db
      .update(switchServers)
      .set({
        name: params.name.trim(),
        apiUrl,
        managed: true,
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
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();
  return mapRow(row);
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

export async function removeServer(id: string): Promise<void> {
  await deleteSessionCookie(id);
  // Unlink agents explicitly: SQLite's ALTER TABLE ADD COLUMN can't carry an
  // ON DELETE clause, so the FK's set-null isn't enforced by the engine.
  await db.update(agents).set({ serverId: null }).where(eq(agents.serverId, id));
  await db.delete(switchServers).where(eq(switchServers.id, id));
  if ((await getActiveServerId()) === id) {
    await db.delete(kv).where(eq(kv.key, ACTIVE_SERVER_KV_KEY));
  }
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
  return encryptedAppSecretsStore.getSecret(cookieSecretKey(serverId));
}

export async function setSessionCookie(serverId: string, jwt: string): Promise<void> {
  await encryptedAppSecretsStore.setSecret(cookieSecretKey(serverId), jwt);
}

export async function deleteSessionCookie(serverId: string): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(cookieSecretKey(serverId));
}
