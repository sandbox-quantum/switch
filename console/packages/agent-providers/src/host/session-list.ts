import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionSchema, type Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { sharedSessionsBase } from './launch';

/**
 * The sessions an agent has on its host, read from the hosts' own state.
 *
 * Each session's host keeps its own record under the agent's host directory.
 * `readHostSessions` reads them; it is self-contained so the same source runs
 * in-process (a watcher answering `list`) and as `LIST_SCRIPT` under `node -e`
 * on a host Console reaches over SSH.
 */
export function readHostSessions(
  nodeFs: typeof fs,
  nodePath: typeof path,
  agentId: string,
  base: string
): ListedSession[] {
  const readJson = (file: string): unknown => {
    for (let attempt = 0; ; attempt++) {
      const text = nodeFs.readFileSync(file, 'utf8');
      try {
        return JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (attempt >= 4)
          throw new Error(`${file} is not readable JSON (${text.length} bytes): ${error.message}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  };
  const lines = (file: string): HostRecord[] => {
    try {
      const text = nodeFs.readFileSync(file, 'utf8');
      const end = text.lastIndexOf('\n') + 1;
      return text
        .slice(0, end)
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  };
  const alive = (root: string): boolean => {
    try {
      const owner = JSON.parse(
        nodeFs.readFileSync(nodePath.join(root, 'supervisor', 'owner.json'), 'utf8')
      );
      process.kill(owner.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let names: string[] = [];
  try {
    names = nodeFs.readdirSync(base);
  } catch {}
  const found: ListedSession[] = [];
  for (const name of names) {
    const root = nodePath.join(base, name);
    let config: HostRecord;
    try {
      config = readJson(nodePath.join(root, 'config.json')) as HostRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!config || !config.session || config.session.agentId !== agentId) continue;
    const upserts = lines(nodePath.join(root, 'events.jsonl')).filter(
      (e) => e && e.body && e.body.type === 'session.upsert'
    );
    const latest = upserts.length ? upserts[upserts.length - 1]!.body!.session : null;
    const stopped = lines(nodePath.join(root, 'inbox.jsonl')).some(
      (r) => r && r.type === 'stopped'
    );
    const handoffs = lines(nodePath.join(root, 'handoff.jsonl'));
    const room = handoffs.length ? (handoffs[handoffs.length - 1]!.roomId ?? null) : null;
    found.push({ session: latest ?? config.session, stopped, room, alive: alive(root) });
  }
  return found;
}

/** The fields `readHostSessions` reads from the lines and files a host keeps. */
type HostRecord = {
  type?: string;
  roomId?: string | null;
  session?: { agentId?: string };
  body?: { type?: string; session?: unknown };
} | null;

export type ListedSession = {
  session: unknown;
  stopped: boolean;
  room: string | null;
  alive: boolean;
};

/**
 * `readHostSessions` as a `node -e` script: `node -e LIST_SCRIPT <agentId>
 * [base]` prints the listing as JSON. An empty base is the default one.
 */
export const LIST_SCRIPT = `
const path = require('node:path');
const [agentId, baseArg] = process.argv.slice(1);
const base = baseArg || path.join(require('node:os').homedir(), '.local', 'state', 'switch', 'sdk-sessions');
process.stdout.write(JSON.stringify((${readHostSessions.toString()})(require('node:fs'), path, agentId, base)));
`;

const listedSchema = z.array(
  z.object({
    session: z.unknown(),
    stopped: z.boolean(),
    room: z.string().nullable(),
    alive: z.boolean(),
  })
);

/**
 * Each listed session as its host last recorded it: the status it reported,
 * whether its host is running now, and the room it was last handed a message
 * in. An entry whose record does not parse is left out.
 */
export function hostSessions(listed: unknown): Session[] {
  return listedSchema.parse(listed).flatMap((entry) => {
    const parsed = sessionSchema.safeParse(entry.session);
    if (!parsed.success) return [];
    return [
      {
        ...parsed.data,
        status: entry.stopped ? 'stopped' : parsed.data.status,
        connectivity: entry.alive ? 'online' : 'offline',
        roomIds: entry.room ? [entry.room] : [],
        retired: false,
      },
    ];
  });
}

/** This agent's sessions under this machine's shared-session base. */
export function listSessions(agentId: string): Session[] {
  return hostSessions(readHostSessions(fs, path, agentId, sharedSessionsBase()));
}
