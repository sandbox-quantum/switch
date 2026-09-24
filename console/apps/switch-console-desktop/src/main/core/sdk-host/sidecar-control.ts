import { CONTROL_FILE, ControlClient } from '@switch-console/agent-providers';
import { z } from 'zod';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { log } from '@main/lib/logger';
import { READ_JSON } from './remote-json';

/**
 * Console's connection to an agent's sidecar on its SSH host.
 *
 * The sidecar is the parent of the sessions it runs and talks to each over
 * IPC. It listens on a loopback port and leaves the port and a secret in
 * `control.json` in its state root; Console reads that file over SSH and opens
 * the port through the same SSH connection. One connection per agent, opened
 * on first use and again after it drops.
 */

const WATCHER_ROOT_SCRIPT = String.raw`${READ_JSON}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [identity, file] = process.argv.slice(1);
const base = path.join(require('node:os').homedir(), '.local', 'state', 'switch', 'sdk-watchers');
let root = path.join(base, crypto.createHash('sha256').update(identity).digest('hex'));
if (fs.existsSync(base)) {
  const matches = fs.readdirSync(base).filter((name) => {
    try { return readJson(path.join(base, name, 'config.json')).session.agentId === identity; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  });
  if (matches.length > 1) throw new Error('Competing saved watchers require explicit cleanup.');
  if (matches.length) root = path.join(base, matches[0]);
}
try { process.stdout.write(fs.readFileSync(path.join(root, file), 'utf8')); }
catch (e) { if (e.code === 'ENOENT') process.stdout.write('null'); else throw e; }
`;

const controlSchema = z
  .object({ port: z.number().int().positive(), token: z.string().min(1) })
  .nullable();

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

/** How long a call keeps trying while the sidecar is restarting or its connection drops. */
const SIDECAR_RETRY_MS = 20000;

/**
 * Runs `call` against the agent's sidecar, again on a fresh connection if the
 * sidecar could not be reached or the connection closed before it answered,
 * as it does while Console replaces the sidecar with a newer build. Every call
 * made this way is safe to repeat: the sidecar and its hosts deduplicate
 * starts, commands and room messages. The last error is raised once the
 * sidecar has not come back within `SIDECAR_RETRY_MS`.
 */
export async function withSidecar<T>(
  agentId: string,
  call: (client: ControlClient) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + SIDECAR_RETRY_MS;
  let pause = 250;
  for (;;) {
    let client: ControlClient | null = null;
    try {
      client = await sidecarControl(agentId);
      return await call(client);
    } catch (error) {
      const dropped = client === null || client.isClosed;
      if (!dropped || Date.now() + pause > deadline) throw error;
      log.warn('Agent sidecar not reachable; trying again', { agentId, error: String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, pause));
    pause = Math.min(pause * 2, 2000);
  }
}
