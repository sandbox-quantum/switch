import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SwitchEventStream } from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import { Journal } from './journal';
import { ensureSharedProcess, sharedSessionRoot } from './launch';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import { readSharedCredentials, sharedConfigSchema, type SharedHostConfig } from './shared-config';

const assignmentSchema = z.strictObject({
  sequence: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  config: sharedConfigSchema,
});

function sessionIdFor(agentId: string, roomId: string, messageId: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([agentId, roomId, messageId]))
    .digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function stopped(sessionId: string): Promise<boolean> {
  try {
    const text = await readFile(join(sharedSessionRoot(sessionId), 'inbox.jsonl'), 'utf8');
    if (text && !text.endsWith('\n'))
      throw new Error(
        'Watcher session journal has an incomplete record; recovery review is required.'
      );
    return text
      .split('\n')
      .slice(0, -1)
      .some((line) => JSON.parse(line).type === 'stopped');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Each assignment is durable before the watcher lets the stream advance its cursor. */
export class SharedWatchAssignments {
  private constructor(private readonly journal: Journal<z.infer<typeof assignmentSchema>>) {}

  static async open(root: string): Promise<SharedWatchAssignments> {
    return new SharedWatchAssignments(
      await Journal.load(join(root, 'assignments.jsonl'), (value) => assignmentSchema.parse(value))
    );
  }

  get cursor(): number {
    return this.journal.records.at(-1)?.sequence ?? 0;
  }

  async assign(
    template: SharedHostConfig,
    event: { sequence: number; roomId: string; messageId: string }
  ): Promise<SharedHostConfig> {
    const duplicate = this.journal.records.find((record) => record.sequence === event.sequence);
    if (duplicate) {
      if (duplicate.roomId !== event.roomId || duplicate.messageId !== event.messageId)
        throw new Error('Watcher sequence changed message identity.');
      return duplicate.config;
    }
    const previous = [...this.journal.records]
      .reverse()
      .find((record) => record.roomId === event.roomId);
    let config: SharedHostConfig;
    if (previous && !(await stopped(previous.config.session.sessionId))) config = previous.config;
    else {
      config = structuredClone(template);
      const sessionId = sessionIdFor(template.session.agentId, event.roomId, event.messageId);
      config.session = { ...config.session, sessionId, hostId: randomUUID(), epoch: randomUUID() };
      config.start.input.sessionId = sessionId;
      if (config.start.input.env.SWITCHDASH_SESSION_ID !== undefined)
        config.start.input.env.SWITCHDASH_SESSION_ID = sessionId;
      delete config.start.input.resume;
      config.roomConnection = {
        connectionId: randomUUID(),
        rooms: [event.roomId],
        startCursor: event.sequence - 1,
      };
    }
    await this.journal.append({ ...event, config });
    return config;
  }

  sessions(): SharedHostConfig[] {
    return [
      ...new Map(
        this.journal.records.map((record) => [record.config.session.sessionId, record.config])
      ).values(),
    ];
  }
}

export async function runSharedWatcher(
  root: string,
  entrypoint: string,
  template: SharedHostConfig,
  signal: AbortSignal
): Promise<void> {
  const ownerPath = join(root, 'shared-owner.lock');
  const owner = { pid: process.pid, token: randomUUID() };
  await withOwnershipLock(root, async () => {
    try {
      const { pid } = z
        .object({ pid: z.number().int().positive() })
        .parse(JSON.parse(await readFile(ownerPath, 'utf8')));
      process.kill(pid, 0);
      throw new Error('The shared SDK watcher is already running.');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await replaceOwner(ownerPath, owner);
  });
  const stop = new AbortController();
  const abort = () => stop.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let fault: Error | null = null;
  let pending: Promise<void> = Promise.resolve();
  const fail = (error: Error) => {
    fault = error;
    stop.abort(error);
  };
  try {
    if (!template.execution || !template.roomConnection)
      throw new Error('Shared watcher requires execution credentials and a connection identity.');
    const enabled = async () =>
      z
        .object({ enabled: z.boolean() })
        .parse(JSON.parse(await readFile(join(root, 'watch.json'), 'utf8'))).enabled;
    if (!(await enabled())) return;
    const credentials = await readSharedCredentials(template);
    const assignments = await SharedWatchAssignments.open(root);
    const launch = async (config: SharedHostConfig) => {
      if (!(await enabled()) || (await stopped(config.session.sessionId))) return;
      await ensureSharedProcess({
        root: sharedSessionRoot(config.session.sessionId),
        entrypoint,
        config,
        resuming: false,
        watcher: false,
        restart: false,
      });
    };
    for (const config of assignments.sessions()) await launch(config);
    const stream = new SwitchEventStream({
      creds: {
        agentId: credentials.SWITCH_AGENT_ID,
        apiEndpoint: credentials.SWITCH_API_ENDPOINT,
        token: credentials.SWITCH_API_TOKEN,
      },
      connectionId: template.roomConnection.connectionId,
      scope: 'all',
      filter: 'addressed',
      spawnCapable: true,
      rooms: [],
      startCursor: assignments.cursor || undefined,
      signal: stop.signal,
      log: console,
      onEvent: (event) => {
        pending = pending.then(async () => {
          if (event.type !== 'message')
            throw new Error(
              `Shared SDK auto-start does not support ${event.type}; open a session to handle this event.`
            );
          const payload = z
            .object({ message_id: z.string().min(1), addressed: z.literal(true) })
            .parse(event.payload);
          const config = await assignments.assign(
            sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
            {
              sequence: z.number().int().positive().parse(event.sequence),
              roomId: event.room_id,
              messageId: payload.message_id,
            }
          );
          await launch(config);
        });
        return pending.catch((error: Error) => {
          fail(error);
          throw error;
        });
      },
      onGap: (gap) =>
        fail(
          new Error(
            `Shared SDK watcher delivery gap: ${gap.reason}. Read room context before restarting.`
          )
        ),
      onEvicted: (reason) => {
        if (reason === 'heartbeat lapsed')
          console.warn('Watcher heartbeat lapsed; reconnecting from the saved cursor.');
        else fail(new Error(`Shared SDK watcher was evicted: ${reason}`));
      },
    });
    stream.start();
    while (!stop.signal.aborted) {
      const enabled = z
        .object({ enabled: z.boolean() })
        .parse(JSON.parse(await readFile(join(root, 'watch.json'), 'utf8'))).enabled;
      if (!enabled) break;
      await delay(500, undefined, { signal: stop.signal });
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    stop.abort();
    signal.removeEventListener('abort', abort);
    await pending.catch(() => {});
    await releaseOwner(root, ownerPath, owner);
  }
  if (fault) throw fault;
}
