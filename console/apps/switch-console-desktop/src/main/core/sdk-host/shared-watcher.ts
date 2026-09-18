import { readFile } from 'node:fs/promises';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationManager } from '@main/core/locations/location-manager';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { locationTransport, type LocationTransport } from '@main/core/locations/location-transport';
import { adoptSubagent } from './adopt-subagent';
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

export async function configureSharedWatcher(
  agentId: string,
  enabled: boolean,
  name?: string
): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
  if (!agent.switchAgentId) {
    if (!enabled) return;
    throw new Error('Link the agent to Switch before enabling automatic sessions.');
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
  await runSharedHostCommand(transport, { ctx, root, entrypoint }, config, '--ensure-watch', false);
}
