import {
  SessionReplica,
  serverEventSchema,
  snapshotSchema,
  type CommandStatus,
  type ServerEvent,
  type Snapshot,
} from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';

/**
 * A session's transcript read from its host's own journal (`events.jsonl`),
 * on this machine or on the agent's SSH host, instead of from Switch.
 *
 * One long-lived `node` process per open session tails the journal and
 * reports, every two seconds, whether the host's supervisor is alive and what
 * the last lease said about the session's rooms. The same script runs locally
 * and remotely, so there is one reader to keep right.
 */
export const TAIL_SCRIPT = String.raw`
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [sessionId, baseArg] = process.argv.slice(1);
const base = baseArg || path.join(os.homedir(), '.local', 'state', 'switch', 'sdk-sessions');
const root = path.join(base, createHash('sha256').update(sessionId).digest('hex'));
const file = path.join(root, 'events.jsonl');
const say = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (!fs.existsSync(file)) {
  say({ missing: true });
  process.exit(0);
}
let offset = 0;
let rest = Buffer.alloc(0);
const pump = () => {
  const size = fs.statSync(file).size;
  if (size <= offset) return;
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(size - offset);
  const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
  fs.closeSync(fd);
  offset += read;
  const buffer = Buffer.concat([rest, chunk.subarray(0, read)]);
  const end = buffer.lastIndexOf(0x0a) + 1;
  rest = buffer.subarray(end);
  for (const line of buffer.subarray(0, end).toString('utf8').split('\n'))
    if (line) process.stdout.write('{"event":' + line + '}\n');
};
const alive = () => {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'supervisor', 'owner.json'), 'utf8'));
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lease = () => {
  try {
    const lines = fs.readFileSync(path.join(root, 'shared-state.jsonl'), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]) continue;
      let record;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      if (record.type === 'lease') {
        const session = record.snapshot.session;
        return { roomIds: session.roomIds ?? null, retired: session.retired ?? null };
      }
    }
  } catch {}
  return null;
};
const beat = () => say({ alive: alive(), lease: lease() });
pump();
beat();
setInterval(pump, 250);
setInterval(beat, 2000);
`;

const leaseSchema = z
  .object({ roomIds: z.array(z.string()).nullable(), retired: z.boolean().nullable() })
  .nullable();
const lineSchema = z.union([
  z.object({ event: z.unknown() }),
  z.object({ missing: z.literal(true) }),
  z.object({ alive: z.boolean(), lease: leaseSchema }),
]);

export class JournalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalUnavailableError';
  }
}

/** What the tail has said so far about one session. */
export class JournalTail {
  readonly events: ServerEvent[] = [];
  alive: boolean | null = null;
  lease: z.infer<typeof leaseSchema> = null;
  missing = false;
  failure: Error | null = null;
  lastRead = Date.now();
  private partial = '';
  private readonly heard: Promise<void>;
  private settle!: () => void;

  constructor() {
    this.heard = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Feed raw stdout; returns false once there is nothing more worth reading. */
  take(chunk: string): boolean {
    const text = this.partial + chunk;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const parsed = lineSchema.parse(JSON.parse(line));
      if ('event' in parsed) {
        const event = serverEventSchema.parse(parsed.event);
        const last = this.events.at(-1);
        if (last && event.sequence !== last.sequence + 1)
          throw new Error(
            `The session journal skipped from event ${last.sequence} to ${event.sequence}.`
          );
        this.events.push(event);
      } else if ('missing' in parsed) {
        this.missing = true;
        this.settle();
        return false;
      } else {
        this.alive = parsed.alive;
        this.lease = parsed.lease;
        this.settle();
      }
    }
    return true;
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.settle();
  }

  /** Resolves once the tail has said whether the journal exists, or failed. */
  ready(timeoutMs: number): Promise<void> {
    return Promise.race([
      this.heard,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new JournalUnavailableError('The session host did not answer in time.')),
          timeoutMs
        ).unref()
      ),
    ]);
  }

  /** The session as its journal has it, with what only the host's state can add. */
  snapshot(): Snapshot {
    const first = this.events.find((event) => event.body.type === 'session.upsert');
    if (first?.body.type !== 'session.upsert')
      throw new JournalUnavailableError('The session host has not recorded the session yet.');
    let replica = new SessionReplica({
      contractVersion: 1,
      throughSequence: 0,
      session: first.body.session,
      turns: [],
      items: [],
      requests: [],
      commandStatuses: [],
      nextPageToken: null,
    });
    for (const event of this.events) {
      // A reset starts a new epoch in the same journal; the host rebuilds its
      // own view the same way.
      if (
        event.body.type === 'session.upsert' &&
        event.body.session.epoch !== replica.snapshot().session.epoch
      ) {
        const prior = replica.snapshot();
        prior.session = event.body.session;
        replica = new SessionReplica(prior);
      }
      replica.apply(event);
    }
    const snapshot = replica.snapshot();
    snapshot.session.connectivity = this.alive === false ? 'offline' : 'online';
    if (this.lease?.roomIds) snapshot.session.roomIds = this.lease.roomIds;
    if (this.lease?.retired !== null && this.lease?.retired !== undefined)
      snapshot.session.retired = this.lease.retired;
    return snapshotSchema.parse(snapshot);
  }

  /** The host's latest word on a command, or null if it has not recorded it. */
  commandStatus(commandId: string): CommandStatus | null {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const { body } = this.events[index]!;
      if (body.type === 'command.status' && body.commandId === commandId) return body;
    }
    return null;
  }

  after(sequence: number): ServerEvent[] {
    return this.events.filter((event) => event.sequence > sequence);
  }
}

type OpenTail = { tail: JournalTail; stop: AbortController };

const IDLE_MS = 60_000;
const READY_MS = 15_000;

/** One tail per session, opened on first read and closed once nobody reads it. */
export class HostJournals {
  private readonly open = new Map<string, OpenTail>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly contextFor: (agentId: string) => Promise<IExecutionContext>,
    private readonly base: string | null = null
  ) {
    this.sweeper = setInterval(() => this.sweep(), IDLE_MS / 2);
    this.sweeper.unref();
  }

  async tail(agentId: string, sessionId: string): Promise<JournalTail> {
    let entry = this.open.get(sessionId);
    if (entry?.tail.failure) {
      entry.stop.abort();
      this.open.delete(sessionId);
      entry = undefined;
    }
    if (!entry) {
      entry = { tail: new JournalTail(), stop: new AbortController() };
      this.open.set(sessionId, entry);
      const { tail, stop } = entry;
      const ctx = await this.contextFor(agentId);
      void ctx
        .execStreaming(
          'node',
          ['-e', TAIL_SCRIPT, sessionId, this.base ?? ''],
          (chunk) => {
            try {
              return tail.take(chunk);
            } catch (error) {
              tail.fail(error instanceof Error ? error : new Error(String(error)));
              return false;
            }
          },
          { signal: stop.signal }
        )
        .then(
          () => {
            if (!tail.missing && !stop.signal.aborted)
              tail.fail(new Error('The session journal reader stopped.'));
          },
          (error: unknown) => {
            if (!stop.signal.aborted)
              tail.fail(error instanceof Error ? error : new Error(String(error)));
          }
        );
    }
    const { tail } = entry;
    tail.lastRead = Date.now();
    await tail.ready(READY_MS);
    if (tail.failure) throw tail.failure;
    if (tail.missing) {
      this.close(sessionId);
      throw new JournalUnavailableError('This session’s host journal is not on the agent’s host.');
    }
    return tail;
  }

  close(sessionId: string): void {
    this.open.get(sessionId)?.stop.abort();
    this.open.delete(sessionId);
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const sessionId of [...this.open.keys()]) this.close(sessionId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [sessionId, { tail }] of this.open)
      if (now - tail.lastRead > IDLE_MS) this.close(sessionId);
  }
}

async function agentContext(agentId: string): Promise<IExecutionContext> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error('Agent not found.');
  const location = await getAgentLocation(agent);
  return location.sshHost ? (await connectRemoteAgent(agent)).ctx : new LocalExecutionContext();
}

export const hostJournals = new HostJournals(agentContext);

export type TranscriptSource = { kind: 'journal' } | { kind: 'switch'; problem: string | null };

/**
 * Where a session's transcript is read from. The host's journal when it can
 * be reached; otherwise Switch, which still has every event the host
 * uploaded. `problem` is set when the journal should have been readable and
 * was not, so the fallback is said rather than silent.
 */
export async function transcriptSource(
  agentId: string,
  sessionId: string
): Promise<TranscriptSource> {
  try {
    await hostJournals.tail(agentId, sessionId);
    return { kind: 'journal' };
  } catch (error) {
    if (error instanceof JournalUnavailableError) return { kind: 'switch', problem: null };
    log.warn('Could not read the session host journal; reading the transcript from Switch', {
      sessionId,
      error: String(error),
    });
    return { kind: 'switch', problem: String(error) };
  }
}
