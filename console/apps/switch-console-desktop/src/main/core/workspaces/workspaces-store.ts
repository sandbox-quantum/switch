import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, type DrizzleTx } from '@main/db/client';
import { kv, type WorkspaceRow, workspaces } from '@main/db/schema';
import type { Workspace } from '@shared/core/workspaces/workspaces';

const ACTIVE_WORKSPACE_KV_KEY = 'activeWorkspaceId';

function mapRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    tenantId: row.tenantId ?? null,
    slug: row.slug ?? null,
    role: row.role ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const rows = await db.select().from(workspaces).orderBy(asc(workspaces.createdAt));
  return rows.map(mapRow);
}

export async function listWorkspacesForServer(serverId: string): Promise<Workspace[]> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.serverId, serverId))
    .orderBy(asc(workspaces.createdAt));
  return rows.map(mapRow);
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row ? mapRow(row) : null;
}

export async function requireWorkspace(id: string): Promise<Workspace> {
  const workspace = await getWorkspace(id);
  if (!workspace) throw new Error(`No workspace with id ${id}`);
  return workspace;
}

/**
 * The one workspace on a server, for a caller that knows only the server.
 *
 * Servers currently carry exactly one workspace each: the row migration 0050
 * created, or the one `ensureServerWorkspace` creates when a server is
 * registered. Until the user can pick between them, callers that act on a
 * server — onboarding an agent, switching the active scope — resolve through
 * here rather than naming a workspace they have no way to choose.
 *
 * Raises on either edge instead of picking. A server with none is a registration
 * that half-succeeded; a server with several means the caller is the one that
 * has to say which, and attaching an agent to the wrong workspace is not
 * something the user would see until it had already happened.
 */
export async function requireSoleWorkspaceForServer(serverId: string): Promise<Workspace> {
  const found = await listWorkspacesForServer(serverId);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new Error(`Switch server ${serverId} has no workspace`);
  throw new Error(
    `Switch server ${serverId} has ${found.length} workspaces; the caller must name one`
  );
}

/**
 * Give a newly registered server its workspace, reusing the one it already has.
 *
 * Registering a server is what creates its first workspace — the gateway is
 * only asked which tenants the user belongs to afterwards, and the app has to
 * be usable before that answer arrives. The row starts tenant-less and named
 * after the server; a reconcile matches it to a tenant rather than replacing
 * it, so the agents pointing at it stay pointed at it.
 *
 * Idempotent, because the managed-server paths run again on every restart of a
 * stack that already exists. The read and the insert share one transaction, so
 * two of those restarts overlapping cannot each find no row and each create
 * one; the partial unique index on the table is the backstop for anything that
 * writes outside this function.
 */
export async function ensureServerWorkspace(server: {
  id: string;
  name: string;
}): Promise<Workspace> {
  return db.transaction((tx) => {
    const [existing] = tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.serverId, server.id))
      .orderBy(asc(workspaces.createdAt))
      .limit(1)
      .all();
    return existing ? mapRow(existing) : insertServerWorkspace(tx, server);
  });
}

/**
 * The insert half of `ensureServerWorkspace`, so a caller registering a server
 * can create both rows in one transaction.
 *
 * A server row without a workspace cannot be used for anything — every path
 * that reaches a gateway resolves a workspace first — and nothing outside
 * registration creates one, so the two rows have to arrive together or not at
 * all.
 */
export function insertServerWorkspace(
  tx: DrizzleTx,
  server: { id: string; name: string }
): Workspace {
  const [row] = tx
    .insert(workspaces)
    .values({
      id: randomUUID(),
      serverId: server.id,
      name: server.name,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning()
    .all();
  return mapRow(row!);
}

/**
 * Carry a server rename onto the workspaces that take their name from it.
 *
 * A tenant-less workspace has no name of its own — it was created named after
 * its server and nothing else has supplied one. Once matched to a tenant the
 * name is the gateway's, and a server rename must not overwrite it.
 */
export async function renameServerWorkspaces(serverId: string, name: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ name, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(workspaces.serverId, serverId), isNull(workspaces.tenantId)));
}

/**
 * The server hosting a workspace, or null when there is no workspace to ask
 * about — an agent that has not been attached to one.
 *
 * A workspace id that names no row is a different thing entirely, and raises:
 * the agents' foreign key means it cannot happen, so if it does the caller is
 * holding an id from somewhere the database does not know about, and answering
 * "no server" would send it on to fail somewhere further away.
 */
export async function serverIdForWorkspace(workspaceId: string | null): Promise<string | null> {
  if (!workspaceId) return null;
  const [row] = await db
    .select({ serverId: workspaces.serverId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) throw new Error(`No workspace with id ${workspaceId}`);
  return row.serverId;
}

export async function getActiveWorkspaceId(): Promise<string | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, ACTIVE_WORKSPACE_KV_KEY)).limit(1);
  return row?.value ?? null;
}

export async function setActiveWorkspaceId(id: string): Promise<void> {
  await requireWorkspace(id);
  await db
    .insert(kv)
    .values({ key: ACTIVE_WORKSPACE_KV_KEY, value: id, updatedAt: sql`CURRENT_TIMESTAMP` })
    .onConflictDoUpdate({
      target: kv.key,
      set: { value: id, updatedAt: sql`CURRENT_TIMESTAMP` },
    });
}

/**
 * Drop the active selection if it names one of a server's workspaces.
 *
 * Removing a server takes its workspaces with it (the foreign key cascades),
 * and the selection is a plain `kv` value that nothing cascades to — so it has
 * to be cleared here, while the workspaces are still readable.
 */
export async function clearActiveWorkspaceOnServer(serverId: string): Promise<void> {
  const active = await getActiveWorkspaceId();
  if (!active) return;
  const onServer = (await listWorkspacesForServer(serverId)).some((w) => w.id === active);
  if (onServer) await db.delete(kv).where(eq(kv.key, ACTIVE_WORKSPACE_KV_KEY));
}
