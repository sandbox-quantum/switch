import { readFile } from 'node:fs/promises';
import type { SharedHostConfig } from '@switch-console/agent-providers';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { updateAgent } from '@main/core/agents/updateAgent';
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
import { log } from '@main/lib/logger';
import { adoptSubagent } from './adopt-subagent';
import { stopLegacySidecar } from './legacy-sidecar';
import {
  removeLocalWatcherRoots,
  startLocalWatcher,
  stopLocalWatcher,
  type WatcherIntent,
} from './local-host';
import { buildSharedHostConfig } from './shared-agent-runtime';
import {
  deploySharedHost,
  resolveWatcherRoot,
  runSharedHostCommand,
} from './shared-host-deployment';
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
 * Where a remote watcher's auto-approve is taken from when it is written
 * (CHOO-2893). Several Consoles under one account on a shared host each hold
 * a row for the same agent, and each writes the one watcher on the host from
 * its own row — so a Console that only restarted, or changed something else,
 * would put back an auto-approve another Console had since changed.
 *
 * What they share is the last choice a person made, kept beside the watcher
 * (`auto-approve.json`). Only an explicit change writes it, so a saved spec
 * written from some Console's row — an older Console's above all, which never
 * wrote a choice — is never taken for one.
 *
 * - `host`: the choice on the host, when there is one, and this Console's row
 *   is brought in line with it. Everything but a change to auto-approve.
 * - `this-console`: this Console's row, because the person using it has just
 *   changed it; {@link keepAutoApproveChoice} has put it on the host first.
 */
export type AutoApproveSource = 'host' | 'this-console';

type ConsoleRuntimeMode = 'full-access' | 'approval-required';

const AUTO_APPROVE_CHOICE_FILE = 'auto-approve.json';

/** Prints the auto-approve choice kept beside a watcher, or nothing. */
const READ_AUTO_APPROVE_CHOICE = `const fs=require('node:fs');try{const c=JSON.parse(fs.readFileSync(require('node:path').join(process.argv[1],'${AUTO_APPROVE_CHOICE_FILE}'),'utf8'));console.log(c?.runtimeMode??'')}catch(e){if(e.code!=='ENOENT')throw e}`;

/**
 * Keeps an auto-approve choice beside a watcher, atomically, and — with the
 * third argument `spec` — sets it in the watcher's saved spec too, for one
 * that nothing is about to rewrite. Nothing to do for an agent that has never
 * had a watcher: the first one is written from the row.
 */
const RECORD_AUTO_APPROVE_CHOICE = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const [root,mode,spec]=process.argv.slice(1);if(!fs.existsSync(root))process.exit(0);const put=(file,data)=>{const tmp=file+'.'+crypto.randomUUID();fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,file)};if(spec==='spec'){const f=path.join(root,'config.json');let c=null;try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}if(c){c.start.input.runtimeMode=mode;put(f,c)}}put(path.join(root,'${AUTO_APPROVE_CHOICE_FILE}'),{runtimeMode:mode,at:new Date().toISOString()})`;

function runtimeModeFor(autoApprove: boolean): ConsoleRuntimeMode {
  return autoApprove ? 'full-access' : 'approval-required';
}

type HostContext = Awaited<ReturnType<typeof deploySharedHost>>['ctx'];

async function readAutoApproveChoice(
  ctx: HostContext,
  root: string
): Promise<ConsoleRuntimeMode | null> {
  const { stdout } = await ctx.exec('node', ['-e', READ_AUTO_APPROVE_CHOICE, root]);
  const mode = stdout.trim();
  return mode === 'full-access' || mode === 'approval-required' ? mode : null;
}

/**
 * Take the choice on the host for a watcher about to be written, and bring
 * this Console's row in line so its toggle shows what the agent runs with.
 */
async function adoptHostAutoApprove(
  agentId: string,
  ctx: HostContext,
  root: string,
  config: SharedHostConfig
): Promise<void> {
  const chosen = await readAutoApproveChoice(ctx, root);
  if (chosen === null || chosen === config.start.input.runtimeMode) return;
  log.info('shared-watcher: taking auto-approve from the host, where another Console set it', {
    agentId,
    runtimeMode: chosen,
  });
  config.start.input.runtimeMode = chosen;
  await updateAgent({ agentId, autoApprove: chosen === 'full-access' });
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
 * Keep a person's auto-approve choice on the host, where every Console on the
 * account takes it from — ahead of the push that rewrites the watcher, so a
 * watcher write racing that push takes the new value rather than putting the
 * old one back.
 *
 * Takes the value rather than reading the row, so the caller can put it on the
 * host before the row.
 */
export async function keepAutoApproveChoice(agentId: string, autoApprove: boolean): Promise<void> {
  await writeAutoApproveChoice(agentId, autoApprove, 'choice-only');
}

/**
 * {@link keepAutoApproveChoice}, and the watcher's saved spec too, for an
 * agent whose watcher is not starting sessions — stopped, or connected with
 * automatic sessions off — so nothing is about to rewrite the spec, and the
 * next session it starts should run with the value.
 */
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
 * Puts an agent's controller into the state its settings describe: connected
 * unless somebody stopped it, and spawning only if automatic sessions are on.
 * This is the read of those two settings — callers that are not themselves
 * deciding one of them should come through here rather than assemble a state.
 */
export async function applyControllerState(
  agentId: string,
  intent: WatcherIntent,
  autoApprove: AutoApproveSource = 'host'
): Promise<void> {
  const [stopped, spawning] = await Promise.all([
    listStoppedControllerAgentIds(),
    listAutoSessionAgentIds(),
  ]);
  const connected = !stopped.includes(agentId);
  await configureSharedWatcher(
    agentId,
    { connected, spawning: connected && spawning.includes(agentId) },
    intent,
    undefined,
    autoApprove
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
  name?: string,
  autoApprove: AutoApproveSource = 'host'
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
  // A subagent's watcher runs with its parent's setting, which the parent's
  // own watcher has already taken from the host.
  const ownWatcher = !name || name === agent.name;
  if (ownWatcher && autoApprove === 'host') {
    await adoptHostAutoApprove(agentId, ctx, root, config);
  }
  await runSharedHostCommand(transport, { ctx, root, entrypoint }, config, '--ensure-watch', false);
}
