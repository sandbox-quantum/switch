import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import type { TelemetryEventMap } from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { forgetServerSession } from '@main/core/workspaces/workspace-session';
import {
  clearActiveWorkspaceOnServer,
  ensureServerWorkspace,
  getActiveWorkspaceId,
  insertServerWorkspace,
  listWorkspacesForServer,
  renameServerWorkspaces,
  setActiveWorkspaceId,
} from '@main/core/workspaces/workspaces-store';
import { db } from '@main/db/client';
import { type SwitchServerRow, switchServers } from '@main/db/schema';
import {
  urlOrigin,
  type AddServerParams,
  type ManagedServerRef,
  type RenameServerParams,
  type SwitchServer,
  type UpdateServerParams,
} from '@shared/core/switch-servers/switch-servers';
import { workspaceUnavailability } from '@shared/core/workspaces/workspaces';

// Keyed to the server, not the workspace: one gateway session cookie covers
// every workspace on a server.
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
    const server = mapRow(row);
    await ensureServerWorkspace(server);
    return server;
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
  const server = mapRow(row);
  await ensureServerWorkspace(server);
  // Only the insert: this function also runs on every restart of a stack that
  // already exists, and that is not a server being added.
  trackEvent('server_added', {
    server_kind: ref.kind === 'remote' ? 'remote_managed' : 'local',
    outcome: 'success',
  });
  return server;
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
  const server = db.transaction((tx) => {
    const [row] = tx
      .insert(switchServers)
      .values({
        id: randomUUID(),
        name: params.name.trim(),
        gatewayUrl: normaliseUrl(params.gatewayUrl),
        apiUrl: normaliseUrl(params.apiUrl),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .returning()
      .all();
    const inserted = mapRow(row!);
    insertServerWorkspace(tx, inserted);
    return inserted;
  });
  // Not reported here, unlike the managed insert above: registering a URL is a
  // discrete action with one caller, so the controller reports both of its
  // outcomes together and a single Add cannot produce two events. The managed
  // kinds have no such single owner — two services call that path and so does
  // every restart — which is why it is reported at the insert instead.
  return server;
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
  await renameServerWorkspaces(params.id, params.name.trim());
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
  await renameServerWorkspaces(params.id, params.name.trim());
  return mapRow(row);
}

export async function removeServer(id: string): Promise<void> {
  // Read before the row goes, since nothing afterwards can say what kind it was
  // — but a read that exists only to describe the removal must not prevent it.
  const server = await getServer(id).catch(() => null);

  await deleteSessionCookie(id);
  // Before the delete, while the server's workspaces are still readable.
  await clearActiveWorkspaceOnServer(id);
  // Deleting the server takes its workspaces with it and unlinks their agents,
  // both by foreign key: workspaces cascade, agents are set null.
  await db.delete(switchServers).where(eq(switchServers.id, id));
  forgetServerSession(id);

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

/**
 * Select a server by selecting one of its workspaces.
 *
 * Picks the first when the account turns out to belong to several on that
 * server, rather than refusing the way the paths that attach an agent do. The
 * risks are not the same: showing the wrong workspace is visible and one click
 * from being corrected, while attaching an agent to it is neither. Refusing
 * here would instead fail the managed stack start this runs inside, taking a
 * healthy server down over a question about which of its workspaces to show.
 *
 * "First" means the first that can actually be opened, where there is one: a
 * withdrawn membership and an unmatched placeholder are both refused by the
 * gateway, and landing on either is not a wrong guess a click corrects. Where
 * there is no such workspace it still picks, for the same reason it does not
 * refuse a choice between several — the seam says why on the first call.
 */
export async function setActiveServerId(id: string): Promise<void> {
  const server = await getServer(id);
  if (!server) throw new Error(`No Switch server with id ${id}`);
  const found = await listWorkspacesForServer(id);
  if (found.length === 0) throw new Error(`Switch server ${id} has no workspace`);
  const active = await getActiveWorkspaceId();
  if (found.some((candidate) => candidate.id === active)) return;
  // The rows are oldest first, and the oldest is exactly the one a withdrawn
  // membership or an unmatched placeholder is most likely to be — the row the
  // server was registered with, before the gateway was ever asked.
  const openable = found.find(
    (candidate) => workspaceUnavailability(candidate, found.length) === null
  );
  await setActiveWorkspaceId((openable ?? found[0]!).id);
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
