import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sessionSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { Journal } from './journal';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import { fenceDeadOwner, ownProcessGroup } from './process-fence';
import type { SharedHostOptions } from './shared-host';

const schema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('identity'),
    session: sessionSchema,
    apiUrl: z.string(),
    cwd: z.string(),
    operationId: z.string(),
  }),
  z.strictObject({
    type: z.literal('lease'),
    snapshot: snapshotSchema,
    sourceBase: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('running') }),
  z.strictObject({ type: z.literal('quiesced') }),
  z.strictObject({
    type: z.literal('recover'),
    operationId: z.string(),
    epoch: z.string(),
    sourceBase: z.number().int().nonnegative(),
    throughHostSequence: z.number().int().nonnegative(),
  }),
]);
type Record = z.infer<typeof schema>;

export class SharedState {
  private constructor(
    readonly journal: Journal<Record>,
    private readonly lock: string,
    private readonly root: string,
    private readonly owner: { pid: number; group: number | null; token: string }
  ) {}

  static async open(options: SharedHostOptions): Promise<SharedState> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const lock = join(options.root, 'shared-owner.lock');
    const owner = { pid: process.pid, group: await ownProcessGroup(), token: randomUUID() };
    await withOwnershipLock(options.root, async () => {
      try {
        const owner = z
          .strictObject({
            token: z.string().optional(),
            pid: z.number().int().positive(),
            group: z.number().int().positive().nullable(),
          })
          .parse(JSON.parse(await readFile(lock, 'utf8')));
        await fenceDeadOwner(owner.pid, owner.group);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await replaceOwner(lock, owner);
    });
    try {
      const journal = await Journal.load(join(options.root, 'shared-state.jsonl'), (value) =>
        schema.parse(value)
      );
      const first = journal.records[0];
      const apiUrl = new URL(options.agentApiUrl).href;
      const cwd = resolve(options.input.cwd);
      if (first) {
        if (
          first.type !== 'identity' ||
          first.apiUrl !== apiUrl ||
          first.cwd !== cwd ||
          first.session.sessionId !== options.session.sessionId ||
          first.session.agentId !== options.session.agentId ||
          first.session.hostId !== options.session.hostId ||
          first.session.provider !== options.session.provider
        )
          throw new Error('Shared host saved identity does not match the configuration.');
      } else
        await journal.append({
          type: 'identity',
          session: options.session,
          apiUrl,
          cwd,
          operationId: randomUUID(),
        });
      return new SharedState(journal, lock, options.root, owner);
    } catch (error) {
      await releaseOwner(options.root, lock, owner);
      throw error;
    }
  }

  get identity(): Extract<Record, { type: 'identity' }> {
    const first = this.journal.records[0];
    if (first.type !== 'identity') throw new Error('Missing shared host identity.');
    return first;
  }

  latest<T extends Record['type']>(type: T): Extract<Record, { type: T }> | undefined {
    return [...this.journal.records].reverse().find((record) => record.type === type) as
      | Extract<Record, { type: T }>
      | undefined;
  }

  async unlock(): Promise<void> {
    await releaseOwner(this.root, this.lock, this.owner);
  }
}
