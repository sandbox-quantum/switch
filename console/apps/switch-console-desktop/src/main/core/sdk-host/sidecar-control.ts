import { CONTROL_FILE, ControlClient } from '@switch-console/agent-providers';
import { z } from 'zod';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';

/**
 * Console's connection to an agent's sidecar on its SSH host.
 *
 * The sidecar is the parent of the sessions it runs and talks to each over
 * IPC. It listens on a loopback port and leaves the port and a secret in
 * `control.json` in its state root; Console reads that file over SSH and opens
 * the port through the same SSH connection. One connection per agent, opened
 * on first use and again after it drops.
 */

const WATCHER_ROOT_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [identity, file] = process.argv.slice(1);
const base = path.join(require('node:os').homedir(), '.local', 'state', 'switch', 'sdk-watchers');
let root = path.join(base, crypto.createHash('sha256').update(identity).digest('hex'));
if (fs.existsSync(base)) {
  const matches = fs.readdirSync(base).filter((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(base, name, 'config.json'), 'utf8')).session.agentId === identity; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  });
  if (matches.length > 1) throw new Error('Competing saved watchers require explicit cleanup.');
  if (matches.length) root = path.join(base, matches[0]);
}
try { process.stdout.write(fs.readFileSync(path.join(root, file), 'utf8')); }
catch (e) { if (e.code === 'ENOENT') process.stdout.write('null'); else throw e; }
`;

const controlSchema = z.object({ port: z.number().int().positive(), token: z.string().min(1) }).nullable();

export class SidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarUnavailableError';
  }
}

const clients = new Map<string, Promise<ControlClient>>();

async function connect(agentId: string): Promise<ControlClient> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  const { ctx, proxy } = await connectRemoteAgent(agent);
  const { stdout } = await ctx.exec('node', [
    '-e',
    WATCHER_ROOT_SCRIPT,
    agent.switchAgentId,
    CONTROL_FILE,
  ]);
  const control = controlSchema.parse(JSON.parse(stdout));
  if (!control)
    throw new SidecarUnavailableError(
      "The agent's sidecar is not running on its host. Start it from the agent's settings."
    );
  const channel = await proxy.forwardOut(control.port);
  const client = new ControlClient(channel, control.token);
  await client.ready;
  return client;
}

/** The control connection to this agent's sidecar, opened if there is none. */
export async function sidecarControl(agentId: string): Promise<ControlClient> {
  const existing = clients.get(agentId);
  if (existing) {
    const client = await existing.catch(() => null);
    if (client && !client.isClosed) return client;
    clients.delete(agentId);
  }
  const opening = connect(agentId);
  clients.set(agentId, opening);
  opening.catch(() => clients.delete(agentId));
  return opening;
}
