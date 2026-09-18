import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SwitchEventStream } from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import { Journal } from './journal';
import { ensureSharedProcess, sharedSessionRoot, type Supervision } from './launch';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import { roomInputId, SharedRoomInbox } from './room-inbox';
import { readSharedCredentials, sharedConfigSchema, type SharedHostConfig } from './shared-config';

const assignmentSchema = z.strictObject({
  sequence: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  config: sharedConfigSchema,
});

/** Marks where the server's sequence numbering restarted. */
const restartSchema = z.strictObject({ restarted: z.literal(true), at: z.string().min(1) });
const recordSchema = z.union([assignmentSchema, restartSchema]);

type Assignment = z.infer<typeof assignmentSchema>;
type WatchRecord = z.infer<typeof recordSchema>;

function restarted(record: WatchRecord): record is z.infer<typeof restartSchema> {
  return 'restarted' in record;
}

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
  private constructor(private readonly journal: Journal<WatchRecord>) {}

  static async open(root: string): Promise<SharedWatchAssignments> {
    return new SharedWatchAssignments(
      await Journal.load(join(root, 'assignments.jsonl'), (value) => recordSchema.parse(value))
    );
  }

  /** Assignments made under the server's current numbering. */
  private get current(): Assignment[] {
    const records = this.journal.records;
    let index = records.length - 1;
    while (index >= 0 && !restarted(records[index]!)) index--;
    return records.slice(index + 1) as Assignment[];
  }

  private get every(): Assignment[] {
    return this.journal.records.filter((record): record is Assignment => !restarted(record));
  }

  get cursor(): number {
    return this.current.at(-1)?.sequence ?? 0;
  }

  /**
   * Notes that the server restarted its numbering. Past sequence numbers no
   * longer identify an event, so they stop being read as a saved position or
   * matched for duplicates — but which session serves which room is kept.
   */
  async restart(): Promise<void> {
    await this.journal.append({ restarted: true, at: new Date().toISOString() });
  }

  async assign(
    template: SharedHostConfig,
    event: { sequence: number; roomId: string; messageId: string }
  ): Promise<SharedHostConfig> {
    const duplicate = this.current.find((record) => record.sequence === event.sequence);
    if (duplicate) {
      if (duplicate.roomId !== event.roomId || duplicate.messageId !== event.messageId)
        throw new Error('Watcher sequence changed message identity.');
      return duplicate.config;
    }
    const previous = [...this.every].reverse().find((record) => record.roomId === event.roomId);
    let config: SharedHostConfig;
    const savedRooms = previous
      ? await SharedRoomInbox.savedRooms(sharedSessionRoot(previous.config.session.sessionId))
      : null;
    if (
      previous &&
      !(await stopped(previous.config.session.sessionId)) &&
      (savedRooms === null || savedRooms.includes(event.roomId))
    )
      config = previous.config;
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
        this.every.map((record) => [record.config.session.sessionId, record.config])
      ).values(),
    ];
  }
}

export async function runSharedWatcher(
  root: string,
  template: SharedHostConfig,
  signal: AbortSignal,
  supervision: Supervision
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
        config,
        resuming: false,
        watcher: false,
        restart: false,
        supervision,
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
          const messageId = roomInputId(event);
          if (!messageId) return;
          const config = await assignments.assign(
            sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
            {
              sequence: z.number().int().positive().parse(event.sequence),
              roomId: event.room_id,
              messageId,
            }
          );
          await launch(config);
        });
        return pending.catch((error: Error) => {
          fail(error);
          throw error;
        });
      },
      // A gap is terminal for a session host, which has context to re-read. The
      // watcher has none: the events it missed are gone from the server, and
      // the sessions it starts read room context themselves. Stopping here
      // would end auto-start until someone deleted this journal by hand — and
      // a server restart resets the numbering, so it would happen again on
      // every reconnect.
      onGap: (gap) => {
        console.warn(
          `Shared SDK watcher delivery gap: ${gap.reason}. Resuming from the server's current position; rooms addressed during the gap must be re-addressed to start a session.`
        );
        if (!gap.cursorReset) return;
        pending = pending.then(() => assignments.restart());
        return pending.catch((error: Error) => {
          fail(error);
          throw error;
        });
      },
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
