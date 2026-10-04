import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { HostControllerRecord, HostControllerRecords } from './host-controller-service';

const recordSchema = z.object({
  sshHost: z.string().min(1),
  serverId: z.string().min(1),
  controllerId: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  supervision: z.enum(['systemd', 'detached']),
  dataDir: z.string().min(1),
  bundle: z.string().min(1),
  sharedHost: z.string().min(1),
  node: z.string().min(1),
  path: z.string(),
  enrolledAt: z.string(),
});

const fileSchema = z.object({ version: z.literal(1), hosts: z.array(recordSchema) });

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

/**
 * `host-controllers/state.json` under user data: per SSH host and server, the
 * controller Console installed there. Read whole and written whole, one
 * change at a time.
 */
export class HostControllerFile implements HostControllerRecords {
  private tail: Promise<unknown> = Promise.resolve();

  /** `path` is resolved on first use: the user-data directory is not settled at import time. */
  constructor(private readonly path: () => string) {}

  async all(): Promise<HostControllerRecord[]> {
    await this.tail.catch(() => {});
    return this.read();
  }

  async get(sshHost: string, serverId: string): Promise<HostControllerRecord | null> {
    return (
      (await this.all()).find(
        (record) => record.sshHost === sshHost && record.serverId === serverId
      ) ?? null
    );
  }

  set(record: HostControllerRecord): Promise<void> {
    const parsed = recordSchema.parse(record);
    return this.change((records) => [
      ...records.filter(
        (other) => !(other.sshHost === parsed.sshHost && other.serverId === parsed.serverId)
      ),
      parsed,
    ]);
  }

  delete(sshHost: string, serverId: string): Promise<void> {
    return this.change((records) =>
      records.filter((other) => !(other.sshHost === sshHost && other.serverId === serverId))
    );
  }

  private change(
    update: (records: HostControllerRecord[]) => HostControllerRecord[]
  ): Promise<void> {
    const next = this.tail
      .catch(() => {})
      .then(async () => {
        const hosts = update(await this.read());
        await writeAtomic(this.path(), JSON.stringify({ version: 1, hosts }, null, 2));
      });
    this.tail = next;
    return next;
  }

  private async read(): Promise<HostControllerRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return fileSchema.parse(JSON.parse(text)).hosts;
  }
}
