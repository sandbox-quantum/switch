import { readFile } from 'node:fs/promises';
import type { SharedHostConfig } from '@switch-console/agent-providers';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { updateAgent } from '@main/core/agents/updateAgent';
import { locationManager } from '@main/core/locations/location-manager';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { locationTransport, type LocationTransport } from '@main/core/locations/location-transport';
import { log } from '@main/lib/logger';
import { adoptSubagent } from './adopt-subagent';
import { stopLegacySidecar } from './legacy-sidecar';
import { startLocalWatcher, stopLocalWatcher } from './local-host';
import { buildSharedHostConfig } from './shared-agent-runtime';
import { deploySharedHost, runSharedHostCommand } from './shared-host-deployment';
import { waitForWatcherStop } from './watcher-inspection';

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
 * - `host`: the watcher's saved launch spec on the host, when there is one,
 *   and this Console's row is brought in line with it. Everything but a change
 *   to auto-approve itself.
 * - `this-console`: this Console's row, because the person using it has just
 *   changed it.
 */
export type AutoApproveSource = 'host' | 'this-console';

type ConsoleRuntimeMode = 'full-access' | 'approval-required';

/** Prints the saved spec's runtime mode, or nothing when there is no spec. */
const READ_SAVED_RUNTIME_MODE =
  "const fs=require('node:fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(c?.start?.input?.runtimeMode??'')}catch(e){if(e.code!=='ENOENT')throw e}";

/** Sets the saved spec's runtime mode, atomically, when there is a spec. */
const WRITE_SAVED_RUNTIME_MODE =
  "const fs=require('node:fs');const [file,mode]=process.argv.slice(1);let c;try{c=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')process.exit(0);throw e}c.start.input.runtimeMode=mode;const tmp=file+'.'+require('node:crypto').randomUUID();fs.writeFileSync(tmp,JSON.stringify(c),{mode:0o600});fs.renameSync(tmp,file)";

function runtimeModeFor(autoApprove: boolean): ConsoleRuntimeMode {
  return autoApprove ? 'full-access' : 'approval-required';
}

async function readSavedRuntimeMode(
  ctx: Awaited<ReturnType<typeof deploySharedHost>>['ctx'],
  root: string
): Promise<ConsoleRuntimeMode | null> {
  const { stdout } = await ctx.exec('node', ['-e', READ_SAVED_RUNTIME_MODE, `${root}/config.json`]);
  const mode = stdout.trim();
  return mode === 'full-access' || mode === 'approval-required' ? mode : null;
}

/**
 * Take the host's auto-approve for a watcher about to be written, and bring
 * this Console's row in line so its toggle shows what the agent runs with.
 */
async function adoptHostAutoApprove(
  agentId: string,
  ctx: Awaited<ReturnType<typeof deploySharedHost>>['ctx'],
  root: string,
  config: SharedHostConfig
): Promise<void> {
  const saved = await readSavedRuntimeMode(ctx, root);
  if (saved === null || saved === config.start.input.runtimeMode) return;
  log.info('shared-watcher: taking auto-approve from the host, where another Console set it', {
    agentId,
    runtimeMode: saved,
  });
  config.start.input.runtimeMode = saved;
  await updateAgent({ agentId, autoApprove: saved === 'full-access' });
}

/**
 * Write an agent's auto-approve into its watcher's saved spec on the host
 * while the watcher is not running, so turning automatic sessions on later —
 * from this Console or another — starts with the value just chosen rather than
 * the one saved before. Nothing to do when the agent has no saved spec: the
 * first watcher is written from the row.
 */
export async function recordAutoApproveOnHost(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
  if (!agent.switchAgentId) return;
  const location = await getAgentLocation(agent);
  if (location.observed) return;
  const transport = locationTransport(location);
  if (transport.kind !== 'ssh') return;
  const { ctx, root } = await deploySharedHost(transport, location.dir, agent.switchAgentId, true);
  await ctx.exec('node', [
    '-e',
    WRITE_SAVED_RUNTIME_MODE,
    `${root}/config.json`,
    runtimeModeFor(agent.autoApprove),
  ]);
}

export async function configureSharedWatcher(
  agentId: string,
  enabled: boolean,
  name?: string,
  autoApprove: AutoApproveSource = 'host'
): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
  if (!agent.switchAgentId) {
    if (!enabled) return;
    throw new Error('Link the agent to Switch before enabling automatic sessions.');
  }
  const location = await getAgentLocation(agent);
  // An observed agent's watcher runs on its host under the account that owns
  // it (CHOO-2893). Starting one here would run it as the wrong person and set
  // two watchers fighting over one session lease; stopping it would switch off
  // someone else's auto-session. Either way it is not this Console's.
  if (location.observed) {
    log.info('shared-watcher: leaving an observed agent’s watcher to its owner', {
      agentId,
      enabled,
    });
    return;
  }
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
    transport,
    { rooms: [], startCursor: 0 }
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
  // A local agent is watched from inside Console so it stops answering when
  // Console does. Only an SSH host gets a detached shared host of its own.
  if (transport.kind !== 'ssh') {
    if (enabled) await startLocalWatcher(config);
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
  await ctx.exec('node', [
    '-e',
    "const fs=require('node:fs');const path=require('node:path');const [root,enabled]=process.argv.slice(1);fs.mkdirSync(root,{recursive:true,mode:0o700});const dest=path.join(root,'watch.json');const tmp=dest+'.'+require('node:crypto').randomUUID();const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({enabled:enabled==='true'}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,dest)",
    root,
    String(enabled),
  ]);
  if (!enabled) {
    await ctx.exec('node', ['-e', waitForWatcherStop, root]);
    return;
  }
  // A subagent's watcher runs with its parent's setting, which the parent's
  // own watcher has already taken from the host.
  const ownWatcher = !name || name === agent.name;
  if (autoApprove === 'host' && ownWatcher) {
    await adoptHostAutoApprove(agentId, ctx, root, config);
  }
  await runSharedHostCommand(transport, { ctx, root, entrypoint }, config, '--ensure-watch', false);
}
