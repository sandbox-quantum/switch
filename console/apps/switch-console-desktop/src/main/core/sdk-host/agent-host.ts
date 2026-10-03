import { readFile } from 'node:fs/promises';
import { controllerConnectionId } from '@switch-console/agent-providers';
import {
  AgentManagedByControllerError,
  managedRecordFor,
} from '@main/core/agent-migration/managed-agents-store';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { updateAgent } from '@main/core/agents/updateAgent';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { locationManager } from '@main/core/locations/location-manager';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { locationTransport, type LocationTransport } from '@main/core/locations/location-transport';
import { ensureServerSessionReady } from '@main/core/managed-switch-server/session-readiness';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { listStoppedControllerAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import { adoptSubagent } from './adopt-subagent';
import {
  removeLocalWatcherRoots,
  startLocalWatcher,
  stopLocalWatcher,
  type WatcherIntent,
} from './local-host';
import { buildSharedHostConfig } from './shared-agent-runtime';
import { deploySharedHost, resolveWatcherRoot } from './shared-host-deployment';
import { AUTO_APPROVE_CHOICE_FILE, bringUpRemoteWatcher } from './watcher-bring-up';
import { removeWatcherRoots } from './watcher-inspection';

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
 * Where a remote watcher's auto-approve comes from when it is written. Several
 * Consoles on one account write the same watcher from their own rows, so the
 * shared value is the last explicit choice, kept in `auto-approve.json` rather
 * than read from the saved spec, which any Console's row may have written.
 *
 * - `host`: that choice, when there is one; this Console's row is synced to it.
 * - `this-console`: this Console's row, just changed by its user.
 */
export type AutoApproveSource = 'host' | 'this-console';

type ConsoleRuntimeMode = 'full-access' | 'approval-required';

/**
 * Atomically keeps an auto-approve choice beside a watcher and, with a third
 * argument `spec`, in its saved spec too. A missing root is a no-op: the first
 * watcher is written from the row.
 */
const RECORD_AUTO_APPROVE_CHOICE = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const [root,mode,spec]=process.argv.slice(1);if(!fs.existsSync(root))process.exit(0);const put=(file,data)=>{const tmp=file+'.'+crypto.randomUUID();fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,file)};if(spec==='spec'){const f=path.join(root,'config.json');let c=null;try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}if(c){c.start.input.runtimeMode=mode;put(f,c)}}put(path.join(root,'${AUTO_APPROVE_CHOICE_FILE}'),{runtimeMode:mode,at:new Date().toISOString()})`;

function runtimeModeFor(autoApprove: boolean): ConsoleRuntimeMode {
  return autoApprove ? 'full-access' : 'approval-required';
}

async function writeAutoApproveChoice(
  agentId: string,
  autoApprove: boolean,
  what: 'spec' | 'choice-only'
): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
  if (!agent.switchAgentId) return;
  const location = await getAgentLocation(agent);
  const transport = locationTransport(location);
  if (transport.kind !== 'ssh') return;
  const { ctx, root } = await resolveWatcherRoot(transport, location.dir, agent.switchAgentId);
  await ctx.exec('node', [
    '-e',
    RECORD_AUTO_APPROVE_CHOICE,
    root,
    runtimeModeFor(autoApprove),
    what,
  ]);
}

/**
 * Keep a person's auto-approve choice on the host ahead of the push that
 * rewrites the watcher, so a racing watcher write takes the new value. Takes
 * the value rather than reading the row, so the caller can write it first.
 */
export async function keepAutoApproveChoice(agentId: string, autoApprove: boolean): Promise<void> {
  await writeAutoApproveChoice(agentId, autoApprove, 'choice-only');
}

/** {@link keepAutoApproveChoice}, and the saved spec too, for a watcher that is
 * not starting sessions and so has nothing about to rewrite its spec. */
export async function recordAutoApproveOnHost(
  agentId: string,
  autoApprove: boolean
): Promise<void> {
  await writeAutoApproveChoice(agentId, autoApprove, 'spec');
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
 * Puts an agent's controller into the state its settings describe: connected,
 * and starting sessions when addressed, unless somebody stopped it. Callers
 * that are not themselves stopping or starting it should come through here
 * rather than assemble a state.
 */
export async function applyControllerState(
  agentId: string,
  intent: WatcherIntent,
  autoApprove: AutoApproveSource
): Promise<void> {
  // A moved agent's controller runs it; its settings describe that controller's watcher, not ours.
  const agent = await getAgentById(agentId);
  if (agent && (await managedRecordFor(agentId, agent.switchAgentId))) {
    log.info('agent-host: leaving a managed agent to its controller', { agentId });
    return;
  }
  const connected = !(await listStoppedControllerAgentIds()).includes(agentId);
  await configureAgentHostFor(agentId, { connected, spawning: connected }, intent, {
    name: undefined,
    autoApprove,
  });
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

/** Which watcher — the agent's own, or its subagent `name`'s — and where its
 * auto-approve comes from. */
export type WatcherTarget = { name: string | undefined; autoApprove: AutoApproveSource };

/** {@link configureAgentHostFor}, taking auto-approve from the host. */
export function configureAgentHost(
  agentId: string,
  state: ControllerState,
  intent: WatcherIntent,
  name?: string
): Promise<void> {
  return configureAgentHostFor(agentId, state, intent, { name, autoApprove: 'host' });
}

export async function configureAgentHostFor(
  agentId: string,
  state: ControllerState,
  intent: WatcherIntent,
  { name, autoApprove }: WatcherTarget
): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
  if (!agent.switchAgentId) {
    if (!state.connected) return;
    throw new Error('Link the agent to Switch before it can hold a room connection.');
  }
  if (state.connected && (await managedRecordFor(agentId, agent.switchAgentId)))
    throw new AgentManagedByControllerError(agent.name);
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
  // A subagent's watcher runs with its parent's setting, which the parent's
  // own watcher has already taken from the host.
  const ownWatcher = !name || name === agent.name;
  // `clear` removes the stood-down marker on the same hop that writes the
  // enable flag: an explicit start, or any stop. A restore leaves it, so a
  // watcher that was displaced stays displaced across a Console restart.
  const brought = await bringUpRemoteWatcher({
    transport,
    repoDir: location.dir,
    identity: config.session.agentId,
    credentialsPath: config.execution!.credentialsPath,
    state,
    clear: !state.connected || intent === 'explicit',
    adoptAutoApprove: state.connected && ownWatcher && autoApprove === 'host',
    config,
  });
  if (brought.legacyStopped.length)
    log.warn('Stopped a superseded sidecar deployment for this agent', {
      agentId,
      stopped: brought.legacyStopped,
    });
  if (brought.runtimeMode !== null) {
    log.info('agent-host: taking auto-approve from the host, where another Console set it', {
      agentId,
      runtimeMode: brought.runtimeMode,
    });
    await updateAgent({ agentId, autoApprove: brought.runtimeMode === 'full-access' });
  }
}
