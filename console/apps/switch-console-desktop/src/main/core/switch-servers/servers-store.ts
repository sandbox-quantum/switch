import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import type { TelemetryEventMap } from '@main/core/telemetry/events';
import { forgetSessionAccount, recordSessionAccount } from '@main/core/telemetry/internal-account';
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
import { log } from '@main/lib/logger';
import {
  normaliseServerUrl,
  urlOrigin,
  type AddServerParams,
  type ManagedServerParams,
  type ManagedServerRef,
  type RenameServerParams,
  type SwitchServer,
  type UpdateServerParams,
} from '@shared/core/switch-servers/switch-servers';
import { workspaceUnavailability } from '@shared/core/workspaces/workspaces';
import { deleteManagedClaudeCredential } from './managed-claude-credential';

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
    url: row.url,
    dashboardUrl: row.dashboardUrl ?? null,
    managed: row.managed,
    managementKind,
    sshHost: row.sshHost ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The spelling an address is stored and compared in; see {@link normaliseServerUrl}. */
const normaliseUrl = normaliseServerUrl;

/**
 * Find the registered server an agent endpoint belongs to, by matching the
 * endpoint's origin against each server's address — what an agent's
 * `SWITCH_API_ENDPOINT` points at. Returns null when none matches.
 */
export async function findServerByEndpoint(endpoint: string): Promise<SwitchServer | null> {
  const target = urlOrigin(endpoint);
  if (!target) return null;
  const servers = await listServers();
  return servers.find((s) => urlOrigin(s.url) === target) ?? null;
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

/** Where a managed server's stack runs, in the words the UI uses. */
function managedPlace(server: SwitchServer): string {
  return server.managementKind === 'remote' && server.sshHost
    ? `on ${server.sshHost}`
    : 'on this computer';
}

/** Two server records cannot share an address, and a shared remote stack's
 * mirrored `localhost` port may be one this Console already gave another server. */
export class ManagedServerUrlConflictError extends Error {
  constructor(url: string, holder: SwitchServer, target: string) {
    super(
      `${url} is already the address of “${holder.name}”` +
        (holder.managed ? ` (the server Switch Console runs ${managedPlace(holder)})` : '') +
        `, and the server ${target} uses the same port. Switch Console reaches a remote ` +
        `server through the same port number on this computer, so both cannot be registered. ` +
        `Remove or disconnect “${holder.name}”, then try again.`
    );
    this.name = 'ManagedServerUrlConflictError';
  }
}

/** The record `ref` already has, and the one at `url`, refusing a clash as
 * {@link ensureManagedServer} describes. */
async function managedServerSlot(
  url: string,
  ref: ManagedServerRef
): Promise<{ existingForTarget: SwitchServer | null; atUrl: SwitchServer | null }> {
  const existingForTarget =
    ref.kind === 'remote' ? await getRemoteManagedServer(ref.sshHost) : await getManagedServer();
  const atUrl = await getServerByUrl(url);
  if (atUrl && atUrl.id !== existingForTarget?.id && (existingForTarget || atUrl.managed)) {
    throw new ManagedServerUrlConflictError(
      url,
      atUrl,
      ref.kind === 'remote' ? `on ${ref.sshHost}` : 'on this computer'
    );
  }
  return { existingForTarget, atUrl };
}

/** Throw {@link ManagedServerUrlConflictError} when {@link ensureManagedServer}
 * would, without writing anything, so a start can check before changing the stack. */
export async function assertManagedServerUrlFree(
  url: string,
  ref: ManagedServerRef
): Promise<void> {
  await managedServerSlot(normaliseUrl(url), ref);
}

/**
 * Upsert a managed server record for the given target (the single local stack,
 * or the stack on a specific remote host). Reuses the existing row for that
 * target if there is one (updating its addresses, which change when ports are
 * repicked), else adopts an external row already at this address, else
 * inserts. Keeps exactly one row per managed target rather than duplicating on
 * URL changes.
 *
 * Another managed target's row is never adopted by URL: taking it over would
 * silently repoint that server and its agents at a different stack. Clashes
 * throw {@link ManagedServerUrlConflictError}.
 */
export async function ensureManagedServer(
  params: ManagedServerParams,
  ref: ManagedServerRef
): Promise<SwitchServer> {
  const url = normaliseUrl(params.url);
  const dashboardUrl = params.dashboardUrl === null ? null : normaliseUrl(params.dashboardUrl);
  const managementKind = ref.kind;
  const sshHost = ref.kind === 'remote' ? ref.sshHost : null;
  const { existingForTarget, atUrl } = await managedServerSlot(url, ref);
  const existing = existingForTarget ?? atUrl;
  if (existing) {
    // Preserve the stored name on restart: the name is set once at creation and
    // then owned by the user (rename). Only the addresses/kind refresh when a managed
    // stack restarts (ports can change), so overwriting name here would clobber a
    // rename — the local stack always restarts with a hardcoded default name.
    const [row] = await db
      .update(switchServers)
      .set({
        url,
        dashboardUrl,
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
      url,
      dashboardUrl,
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

/** The server registered at an address, compared the way it was stored. */
export async function findServerByUrl(url: string): Promise<SwitchServer | null> {
  return getServerByUrl(normaliseUrl(url));
}

/**
 * The server a web address belongs to: its own address, or the separate
 * dashboard address it still keeps. An invite link carries the dashboard's
 * address, which on an older server is not the server's own.
 */
export async function findServerByWebAddress(address: string): Promise<SwitchServer | null> {
  const target = urlOrigin(address);
  if (!target) return null;
  const servers = await listServers();
  return (
    servers.find((s) => urlOrigin(s.url) === target) ??
    servers.find((s) => s.dashboardUrl !== null && urlOrigin(s.dashboardUrl) === target) ??
    null
  );
}

/**
 * Compared in the normalised spelling on both sides rather than by the column:
 * a row saved before addresses were normalised, or carried over by migration
 * 0052, may be stored in another spelling of the same address.
 */
async function getServerByUrl(url: string): Promise<SwitchServer | null> {
  const target = normaliseUrl(url);
  return (await listServers()).find((server) => normaliseUrl(server.url) === target) ?? null;
}

/** A server is already registered at the address being saved. */
export class DuplicateServerUrlError extends Error {
  constructor(url: string, holder: SwitchServer) {
    super(`${url} is already the address of “${holder.name}”.`);
    this.name = 'DuplicateServerUrlError';
  }
}

type StoreTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Refuse `url` when a server other than `exceptId` already has it. Read inside
 * the transaction that writes the row: with no unique index to fall back on,
 * that is what keeps two saves of one address from both passing the check.
 */
function assertUrlFree(tx: StoreTransaction, url: string, exceptId: string | null): void {
  const holder = tx
    .select()
    .from(switchServers)
    .all()
    .map(mapRow)
    .find((server) => normaliseUrl(server.url) === url && server.id !== exceptId);
  if (holder) throw new DuplicateServerUrlError(url, holder);
}

export async function addServer(params: AddServerParams): Promise<SwitchServer> {
  const url = normaliseUrl(params.url);
  const dashboardUrl = params.dashboardUrl === null ? null : normaliseUrl(params.dashboardUrl);
  const server = db.transaction((tx) => {
    assertUrlFree(tx, url, null);
    const [row] = tx
      .insert(switchServers)
      .values({
        id: randomUUID(),
        name: params.name.trim(),
        url,
        dashboardUrl,
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

/**
 * Save an edited server. A changed address also drops any separate dashboard
 * address: that belonged to the address being replaced, and the new one is
 * checked for its own dashboard the next time it is reached.
 */
export async function updateServer(params: UpdateServerParams): Promise<SwitchServer> {
  const url = normaliseUrl(params.url);
  const row = db.transaction((tx) => {
    const [previous] = tx.select().from(switchServers).where(eq(switchServers.id, params.id)).all();
    if (!previous) throw new Error(`No Switch server with id ${params.id}`);
    assertUrlFree(tx, url, params.id);
    const [updated] = tx
      .update(switchServers)
      .set({
        name: params.name.trim(),
        url,
        ...(normaliseUrl(previous.url) !== url ? { dashboardUrl: null } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(switchServers.id, params.id))
      .returning()
      .all();
    return updated!;
  });
  await renameServerWorkspaces(params.id, params.name.trim());
  return mapRow(row);
}

/**
 * Forget a server's separate dashboard address, once its own address has been
 * seen serving the dashboard. Leaves the row alone when the address it was
 * checked against is no longer the server's, so a check that raced an edit
 * cannot clear the fallback of the address that replaced it.
 */
export async function clearDashboardUrl(id: string, checkedUrl: string): Promise<void> {
  await db
    .update(switchServers)
    .set({ dashboardUrl: null, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(switchServers.id, id), eq(switchServers.url, checkedUrl)));
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

  await deleteManagedClaudeCredential(id);
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
  await recordSessionAccount(serverId, jwt).catch((error: unknown) => {
    log.warn('switch-servers: could not record whether the account is internal', { error });
  });
}

export async function deleteSessionCookie(serverId: string): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(cookieSecretKey(serverId));
  await forgetSessionAccount(serverId).catch((error: unknown) => {
    log.warn('switch-servers: could not forget whether the account was internal', { error });
  });
}
