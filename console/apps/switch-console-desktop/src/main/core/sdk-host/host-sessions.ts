import { sessionSchema, type Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';

/**
 * The sessions an agent has on its host, read from the hosts' own state.
 *
 * Switch no longer keeps a record of an agent's sessions; each one's host
 * keeps its own, under the agent's host directory, and this is where Console
 * finds them. One `node` run per call, locally or over the agent's SSH
 * connection: the same script either way.
 */
export const LIST_SCRIPT = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [agentId, baseArg] = process.argv.slice(1);
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
try { names = fs.readdirSync(base); } catch {}
const found = [];
for (const name of names) {
  const root = path.join(base, name);
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { continue; }
  if (!config || !config.session || config.session.agentId !== agentId) continue;
  const upserts = lines(path.join(root, 'events.jsonl')).filter((e) => e && e.body && e.body.type === 'session.upsert');
  const latest = upserts.length ? upserts[upserts.length - 1].body.session : null;
  const stopped = lines(path.join(root, 'inbox.jsonl')).some((r) => r && r.type === 'stopped');
  const handoffs = lines(path.join(root, 'handoff.jsonl'));
  const room = handoffs.length ? handoffs[handoffs.length - 1].roomId : null;
  found.push({ session: latest ?? config.session, stopped, room, alive: alive(root) });
}
process.stdout.write(JSON.stringify(found));
`;

const listedSchema = z.array(
  z.object({
    session: z.unknown(),
    stopped: z.boolean(),
    room: z.string().nullable(),
    alive: z.boolean(),
  })
);

async function agentContext(
  agentId: string
): Promise<{ ctx: IExecutionContext; switchAgentId: string }> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  const location = await getAgentLocation(agent);
  const ctx = location.sshHost
    ? (await connectRemoteAgent(agent)).ctx
    : new LocalExecutionContext();
  return { ctx, switchAgentId: agent.switchAgentId };
}

/**
 * Each session this agent has on its host, as its host last recorded it: the
 * status it reported, whether its host is running now, and the room it was
 * last handed a message in.
 */
export async function listHostSessions(agentId: string): Promise<Session[]> {
  const { ctx, switchAgentId } = await agentContext(agentId);
  const { stdout } = await ctx.exec('node', ['-e', LIST_SCRIPT, switchAgentId, '']);
  return listedSchema.parse(JSON.parse(stdout)).flatMap((entry) => {
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
