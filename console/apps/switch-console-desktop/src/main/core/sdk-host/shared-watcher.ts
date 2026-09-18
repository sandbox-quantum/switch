import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationManager } from '@main/core/locations/location-manager';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { locationTransport } from '@main/core/locations/location-transport';
import { ensureServerSessionReady } from '@main/core/managed-switch-server/session-readiness';
import { getServer } from '@main/core/switch-servers/servers-store';
import { adoptSubagent } from './adopt-subagent';
import { assertLegacySessionsStopped } from './legacy-session-guard';
import { buildSharedHostConfig } from './shared-agent-runtime';
import { deploySharedHost, runSharedHostCommand } from './shared-host-deployment';
import { waitForWatcherStop } from './watcher-inspection';

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
  if (enabled) {
    const server = agent.serverId ? await getServer(agent.serverId) : null;
    if (!server)
      throw new Error('Link the agent to a Switch server before enabling automatic sessions.');
    await ensureServerSessionReady(server);
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
    const { ctx } = await deploySharedHost(transport, location.dir, identity, true);
    const { stdout } = await ctx.exec('node', [
      '-e',
      "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).env.SWITCH_AGENT_ID)",
      config.execution!.credentialsPath,
    ]);
    const remoteId = stdout.trim();
    if (!remoteId || remoteId === 'undefined')
      throw new Error('Subagent Switch identity is missing.');
    config.session.agentId = remoteId;
    await adoptSubagent(agent, name, remoteId);
  }
  const { ctx, root, entrypoint } = await deploySharedHost(
    transport,
    location.dir,
    config.session.agentId,
    true
  );
  if (enabled) await assertLegacySessionsStopped(ctx, agent.id, location.dir, name ?? agent.name);
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
