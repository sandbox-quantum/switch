import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { remoteHosts, type RemoteHostRow } from '@main/db/schema';

export type RemoteHost = {
  sshHost: string;
  name: string;
};

function toRemoteHost(row: RemoteHostRow): RemoteHost {
  return { sshHost: row.sshHost, name: row.name };
}

export async function listRemoteHosts(): Promise<RemoteHost[]> {
  const rows = await db.select().from(remoteHosts).orderBy(remoteHosts.name);
  return rows.map(toRemoteHost);
}

export async function getRemoteHost(sshHost: string): Promise<RemoteHost | null> {
  const [row] = await db
    .select()
    .from(remoteHosts)
    .where(eq(remoteHosts.sshHost, sshHost))
    .limit(1);
  return row ? toRemoteHost(row) : null;
}

/**
 * Onboard an SSH host alias (or rename an already-onboarded one). Idempotent on
 * `sshHost` — re-onboarding updates the display name.
 */
export async function upsertRemoteHost(host: RemoteHost): Promise<RemoteHost> {
  await db
    .insert(remoteHosts)
    .values({ sshHost: host.sshHost, name: host.name })
    .onConflictDoUpdate({
      target: remoteHosts.sshHost,
      set: { name: host.name, updatedAt: new Date().toISOString() },
    });
  const saved = await getRemoteHost(host.sshHost);
  if (!saved) throw new Error(`Failed to onboard remote host ${host.sshHost}`);
  return saved;
}

export async function removeRemoteHost(sshHost: string): Promise<void> {
  await db.delete(remoteHosts).where(eq(remoteHosts.sshHost, sshHost));
}
