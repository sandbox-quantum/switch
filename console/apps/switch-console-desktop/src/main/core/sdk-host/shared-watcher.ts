import { readFile } from 'node:fs/promises';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { locationManager } from '@main/core/locations/location-manager';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { locationTransport, type LocationTransport } from '@main/core/locations/location-transport';
import { ensureServerSessionReady } from '@main/core/managed-switch-server/session-readiness';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import {
  listAutoSessionAgentIds,
  listStoppedControllerAgentIds,
} from '@main/core/switch-rooms/auto-session-store';
import { controllerConnectionId } from '@main/core/switch-rooms/session-connection-id';
import { getServer } from '@main/core/switch-servers/servers-store';
import { adoptSubagent } from './adopt-subagent';
import { stopLegacySidecar } from './legacy-sidecar';
import {
  removeLocalWatcherRoots,
  startLocalWatcher,
  stopLocalWatcher,
  type WatcherIntent,
} from './local-host';
import { buildSharedHostConfig } from './shared-agent-runtime';
import { deploySharedHost, runSharedHostCommand } from './shared-host-deployment';
import { removeWatcherRoots, waitForWatcherStop } from './watcher-inspection';

const READ_SWITCH_AGENT_ID =
  "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).env.SWITCH_AGENT_ID)";

async function readSubagentSwitchId(
  transport: LocationTransport,
  dir: string,
  identity: string,
  credentialsPath: string
): Promise<string> {
  if (transport.kind !== 'ssh') {
    const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
    return String(credentials.env?.SWITCH_AGENT_ID ?? '');
  }
  const { ctx } = await deploySharedHost(transport, dir, identity, true);
  const { stdout } = await ctx.exec('node', ['-e', READ_SWITCH_AGENT_ID, credentialsPath]);
  return stdout.trim();
}

/**
 * What an agent's controller should be doing.
 *
 * `connected` is whether it holds this agent's one inbound connection.
 * `spawning` is whether it may start a session, which is the auto-start setting
 * and only that. A controller that is connected and not spawning is an agent
 * that can be addressed and caught up on, and that starts nothing for the
 * message — so the profile promising a session must not outlive it.
 */
export type ControllerState = { connected: boolean; spawning: boolean };

/**
 * Puts an agent's controller into the state its settings describe: connected
 * unless somebody stopped it, and spawning only if automatic sessions are on.
 * This is the read of those two settings — callers that are not themselves
 * deciding one of them should come through here rather than assemble a state.
 */
export async function applyControllerState(agentId: string, intent: WatcherIntent): Promise<void> {
  const [stopped, spawning] = await Promise.all([
    listStoppedControllerAgentIds(),
    listAutoSessionAgentIds(),
  ]);
  const connected = !stopped.includes(agentId);
  await configureSharedWatcher(
    agentId,
    { connected, spawning: connected && spawning.includes(agentId) },
    intent
  );
}

/**
 * Discards what an agent's controller left on its host — the assignment
 * journal, the flags, the log — once the agent itself is going. Stop the
 * controller first: this removes the files out from under anything still
 * running on them. A root left behind outlives the agent, and an agent
 * registered again under the same Switch identity would adopt it and resume
 * from a cursor belonging to an install that no longer exists.
 */
export async function discardControllerState(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) return;
  const transport = locationTransport(await getAgentLocation(agent));
  if (transport.kind !== 'ssh') {
    await removeLocalWatcherRoots(agent.switchAgentId);
    return;
  }
  const proxy = await ensureSshConnected(transport.connectionId, transport.host);
  const ctx = new SshExecutionContext(proxy, { root: transport.dir });
  await ctx.exec('node', ['-e', removeWatcherRoots, agent.switchAgentId]);
}

export async function configureSharedWatcher(
  agentId: string,
  state: ControllerState,
  intent: WatcherIntent,
  name?: string
): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
  if (!agent.switchAgentId) {
    if (!state.connected) return;
    throw new Error('Link the agent to Switch before it can hold a room connection.');
  }
  // Connecting waits for the agent's managed server to be in step with this
  // build; standing down never does.
  if (state.connected && agent.serverId) {
    const server = await getServer(agent.serverId);
    if (server) await ensureServerSessionReady(server);
  }
  const location = await getAgentLocation(agent);
  const transport = locationTransport(location);
  const identity = `watcher-${agent.switchAgentId}`;
  const opened = await locationManager.openLocation(location);
  if (!opened.success)
    throw new Error(`Cannot read watcher execution settings: ${JSON.stringify(opened.error)}`);
  const settings = await resolveSessionEnv(
    { id: identity, title: 'Room session' },
    { path: location.dir, fs: opened.data.fs },
    opened.data.settings
  );
  const config = await buildSharedHostConfig(
    {
      id: identity,
      agentId,
      providerId: agent.providerId,
      agentName: name ?? agent.name ?? undefined,
    },
    { sessionPath: location.dir, ...settings },
    transport
  );
  if (name && name !== agent.name) {
    const remoteId = await readSubagentSwitchId(
      transport,
      location.dir,
      identity,
      config.execution!.credentialsPath
    );
    if (!remoteId || remoteId === 'undefined')
      throw new Error('Subagent Switch identity is missing.');
    config.session.agentId = remoteId;
    await adoptSubagent(agent, name, remoteId);
  }
  // After the subagent rename above, not before: that path replaces the Switch
  // agent id the whole configuration is about, and the controller id has to be
  // the one belonging to the agent actually being watched.
  config.roomConnection = { connectionId: controllerConnectionId(config.session.agentId) };
  // A local agent is watched from inside Console so it stops answering when
  // Console does. Only an SSH host gets a detached shared host of its own.
  if (transport.kind !== 'ssh') {
    if (state.connected) await startLocalWatcher(config, { intent, spawning: state.spawning });
    else await stopLocalWatcher(config.session.agentId);
    return;
  }
  const { ctx, root, entrypoint } = await deploySharedHost(
    transport,
    location.dir,
    config.session.agentId,
    true
  );
  await stopLegacySidecar(ctx, location.dir, config.execution!.credentialsPath);
  // `clear` removes the stood-down marker on the same hop that writes the
  // enable flag: an explicit start, or any stop. A restore leaves it, so a
  // watcher that was displaced stays displaced across a Console restart.
  await ctx.exec('node', [
    '-e',
    "const fs=require('node:fs');const path=require('node:path');const [root,enabled,spawn,clear]=process.argv.slice(1);fs.mkdirSync(root,{recursive:true,mode:0o700});if(clear==='true')try{fs.unlinkSync(path.join(root,'taken-over.json'))}catch(e){if(e.code!=='ENOENT')throw e}const dest=path.join(root,'watch.json');const tmp=dest+'.'+require('node:crypto').randomUUID();const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({enabled:enabled==='true',spawn:spawn==='true'}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,dest)",
    root,
    String(state.connected),
    String(state.spawning),
    String(!state.connected || intent === 'explicit'),
  ]);
  if (!state.connected) {
    await ctx.exec('node', ['-e', waitForWatcherStop, root]);
    return;
  }
  await runSharedHostCommand(transport, { ctx, root, entrypoint }, config, '--ensure-watch', false);
}
