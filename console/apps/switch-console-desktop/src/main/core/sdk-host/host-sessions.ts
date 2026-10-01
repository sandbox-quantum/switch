import { sessionSchema, type Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { READ_JSON } from './remote-json';
import { IS_STATE_ROOT } from './state-roots';

/**
 * The sessions an agent has on its host, read from the hosts' own state.
 *
 * Switch no longer keeps a record of an agent's sessions; each one's host
 * keeps its own, under the agent's host directory, and this is where Console
 * finds them. One `node` run per call, locally or over the agent's SSH
 * connection: the same script either way.
 *
 * It reports every session on the host with the agent that owns it, rather
 * than filtering to one. Answering for a single agent always meant reading
 * every session directory anyway — the filter only discarded the rest — so
 * returning all of it costs nothing and lets one run serve every agent on
 * the host.
 */
export const LIST_SCRIPT = String.raw`${READ_JSON}${IS_STATE_ROOT}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [, baseArg] = process.argv.slice(1);
const base = baseArg || path.join(os.homedir(), '.local', 'state', 'switch', 'sdk-sessions');
const lines = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const end = text.lastIndexOf('\n') + 1;
    return text.slice(0, end).split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
};
const alive = (root) => {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'supervisor', 'owner.json'), 'utf8'));
    process.kill(owner.pid, 0);
    return true;
  } catch { return false; }
};
let names = [];
try { names = fs.readdirSync(base).filter(isStateRoot); } catch {}
const found = [];
for (const name of names) {
  const root = path.join(base, name);
  let config;
  try { config = readJson(path.join(root, 'config.json')); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  if (!config || !config.session || !config.session.agentId) continue;
  const upserts = lines(path.join(root, 'events.jsonl')).filter((e) => e && e.body && e.body.type === 'session.upsert');
  const latest = upserts.length ? upserts[upserts.length - 1].body.session : null;
  const stopped = lines(path.join(root, 'inbox.jsonl')).some((r) => r && r.type === 'stopped');
  const handoffs = lines(path.join(root, 'handoff.jsonl'));
  const room = handoffs.length ? handoffs[handoffs.length - 1].roomId : null;
  found.push({ agentId: config.session.agentId, session: latest ?? config.session, stopped, room, alive: alive(root) });
}
process.stdout.write(JSON.stringify(found));
`;

const listedSchema = z.array(
  z.object({
    agentId: z.string(),
    session: z.unknown(),
    stopped: z.boolean(),
    room: z.string().nullable(),
    alive: z.boolean(),
  })
);

async function agentContext(
  agentId: string
): Promise<{ ctx: IExecutionContext; switchAgentId: string; hostKey: string }> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  const location = await getAgentLocation(agent);
  const ctx = location.sshHost
    ? (await connectRemoteAgent(agent)).ctx
    : new LocalExecutionContext();
  return {
    ctx,
    switchAgentId: agent.switchAgentId,
    // The pooled SSH connection is per host, so that is also the unit the
    // read below is shared over. Everything local shares one key for the
    // same reason: it is all one machine.
    hostKey: location.sshHost ? sshConnectionIdForHost(location.sshHost) : 'local',
  };
}

/**
 * How long one host's session listing is reused for. Comfortably shorter than
 * the discovery interval, so a normal round still reads fresh state, and long
 * enough to cover a host's agents whose timers have drifted apart.
 */
export const HOST_SESSIONS_TTL_MS = 3000;

const hostReads = new Map<string, { at: number; sessions: Promise<Map<string, Session[]>> }>();

/** Drop every cached listing. For tests, and for "refresh now" paths. */
export function clearHostSessionsCache(): void {
  hostReads.clear();
}

/**
 * Every session on one host, grouped by the Switch agent that owns it.
 *
 * Shared per host, because it used to be per agent and that was the single
 * largest standing cost of running Console: each linked agent listed sessions
 * every 5 seconds, and each listing read *all* of the host's session
 * directories to keep the few that were its own. Twenty agents on a host
 * meant twenty SSH commands every five seconds, forever, down a connection
 * that runs four at a time — and the answers were near-identical.
 *
 * Now one command answers for all of them. Concurrent callers join the
 * in-flight read rather than starting their own, which is what collapses the
 * burst when a host's agents all tick together; the short TTL catches the
 * stragglers whose timers have drifted.
 *
 * A failed read is not cached — the next caller retries rather than being
 * handed a stale rejection.
 */
async function hostSessions(agentId: string): Promise<Map<string, Session[]>> {
  const { ctx, hostKey } = await agentContext(agentId);
  const cached = hostReads.get(hostKey);
  if (cached && Date.now() - cached.at < HOST_SESSIONS_TTL_MS) return cached.sessions;

  const read = (async () => {
    const { stdout } = await ctx.exec('node', ['-e', LIST_SCRIPT, '', '']);
    const byAgent = new Map<string, Session[]>();
    for (const entry of listedSchema.parse(JSON.parse(stdout))) {
      const parsed = sessionSchema.safeParse(entry.session);
      if (!parsed.success) continue;
      const list = byAgent.get(entry.agentId);
      const session = {
        ...parsed.data,
        status: entry.stopped ? ('stopped' as const) : parsed.data.status,
        connectivity: entry.alive ? ('online' as const) : ('offline' as const),
        roomIds: entry.room ? [entry.room] : [],
        retired: false,
      };
      if (list) list.push(session);
      else byAgent.set(entry.agentId, [session]);
    }
    return byAgent;
  })();
  read.catch(() => hostReads.delete(hostKey));
  hostReads.set(hostKey, { at: Date.now(), sessions: read });
  return read;
}

/**
 * Each session this agent has on its host, as its host last recorded it: the
 * status it reported, whether its host is running now, and the room it was
 * last handed a message in.
 *
 * An agent with no sessions gets an empty list, which is a fact about the
 * host rather than a gap: the read covered every agent on it.
 */
export async function listHostSessions(agentId: string): Promise<Session[]> {
  const { switchAgentId } = await agentContext(agentId);
  return (await hostSessions(agentId)).get(switchAgentId) ?? [];
}
