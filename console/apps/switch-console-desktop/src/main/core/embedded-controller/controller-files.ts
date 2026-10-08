import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WATCH_FLAGS_FILE, watchFlagsSchema } from '@switch-console/agent-providers';
import { z } from 'zod';

/**
 * What Console keeps on disk for "Run managed agents on this computer", under
 * `<userData>/agent-controller/`:
 *
 * - `state.json`: per server, the controller this Console enrolled as (id,
 *   server, name, workspace) or the record that the server removed it. No
 *   credential: that is in the encrypted app secrets store.
 * - `servers/<serverId>/`: the embedded controller's data directory, laid out
 *   as the agent-controller package lays it out.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Where a controller on this computer puts agents with no directory of their
 * own, for a server: `~/.switch/agents/<server address>`, as the controller's
 * `serverWorkspacesDir` names it.
 */
export function serverWorkspacesDir(home: string, server: string): string {
  return join(home, '.switch', 'agents', new URL(server).host.replace(/[^A-Za-z0-9._-]+/g, '-'));
}

/**
 * The workspace a controller on this computer makes for an agent with no
 * directory: `<workspaces>/<name>`, as its data layout names it.
 */
export function defaultWorkspacePath(workspaces: string, name: string): string | null {
  if (!WORKSPACE_NAME.test(name) || name.includes('..')) return null;
  return join(workspaces, name);
}

export function controllerDataDir(base: string, serverId: string): string {
  if (!SAFE_ID.test(serverId) || serverId.includes('..'))
    throw new Error(`The server id '${serverId}' cannot name a directory.`);
  return join(base, 'servers', serverId);
}

/** The encrypted app secret holding a server's controller credential. */
export function credentialSecretKey(serverId: string): string {
  return `agent-controller:${serverId}:credential`;
}

const recordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('enrolled'),
    controllerId: z.string().min(1),
    /** The agent bridge URL the controller was enrolled against. */
    server: z.string().min(1),
    name: z.string().min(1),
    workspaceId: z.string().min(1),
    enrolledAt: z.string(),
  }),
  z.object({
    kind: z.literal('removed'),
    controllerId: z.string().min(1),
    at: z.string(),
  }),
]);

export type EnrollmentRecord = z.infer<typeof recordSchema>;

const stateSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), recordSchema),
});

export interface EnrollmentRecords {
  all(): Promise<Record<string, EnrollmentRecord>>;
  get(serverId: string): Promise<EnrollmentRecord | null>;
  set(serverId: string, record: EnrollmentRecord): Promise<void>;
  delete(serverId: string): Promise<void>;
}

async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/** `state.json`, read whole and written whole; every change goes through one queue. */
export class EnrollmentFile implements EnrollmentRecords {
  private tail: Promise<unknown> = Promise.resolve();

  /** `path` is resolved on first use: the user-data directory is not settled at import time. */
  constructor(private readonly path: () => string) {}

  async all(): Promise<Record<string, EnrollmentRecord>> {
    await this.tail.catch(() => {});
    return this.read();
  }

  async get(serverId: string): Promise<EnrollmentRecord | null> {
    return (await this.all())[serverId] ?? null;
  }

  set(serverId: string, record: EnrollmentRecord): Promise<void> {
    return this.change((servers) => ({ ...servers, [serverId]: recordSchema.parse(record) }));
  }

  delete(serverId: string): Promise<void> {
    return this.change((servers) => {
      const rest = { ...servers };
      delete rest[serverId];
      return rest;
    });
  }

  private change(
    update: (servers: Record<string, EnrollmentRecord>) => Record<string, EnrollmentRecord>
  ): Promise<void> {
    const next = this.tail
      .catch(() => {})
      .then(async () => {
        const servers = update(await this.read());
        await writeAtomic(this.path(), JSON.stringify({ version: 1, servers }, null, 2));
      });
    this.tail = next;
    return next;
  }

  private async read(): Promise<Record<string, EnrollmentRecord>> {
    let text: string;
    try {
      text = await readFile(this.path(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return stateSchema.parse(JSON.parse(text)).servers;
  }
}

/**
 * Turns off every watcher under a controller data directory, the way the
 * controller itself does on revocation: `watch.json` set to disabled, which
 * each watcher reads and stops on. For when the controller was not there to
 * hear it was revoked.
 */
export async function turnOffWatchers(dataDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(join(dataDir, 'watchers'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const flags = JSON.stringify(watchFlagsSchema.parse({ enabled: false, spawn: false }));
  let turnedOff = 0;
  for (const entry of entries) {
    if (!SAFE_ID.test(entry)) continue;
    await writeAtomic(join(dataDir, 'watchers', entry, WATCH_FLAGS_FILE), flags);
    turnedOff += 1;
  }
  return turnedOff;
}

/**
 * Forgets which controller a data directory belonged to: its database
 * (identity, cached assignment, cursors) and the agents' relay credentials.
 * The watcher roots and the agents' default workspaces stay: a watcher may
 * still be winding down in its root, and a workspace holds the agent's work.
 */
export async function wipeControllerIdentity(dataDir: string): Promise<void> {
  for (const name of ['controller.db', 'controller.db-wal', 'controller.db-shm'])
    await rm(join(dataDir, name), { force: true });
  await rm(join(dataDir, 'agents'), { recursive: true, force: true });
  await rm(join(dataDir, 'secrets'), { recursive: true, force: true });
}
