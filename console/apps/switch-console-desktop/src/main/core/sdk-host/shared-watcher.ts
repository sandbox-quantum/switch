import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationTransport } from '@main/core/locations/location-transport';
import { buildSharedHostConfig, deploySharedHost } from './shared-agent-runtime';

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
  const identity = `watcher-${agent.switchAgentId}-${name ?? agent.name}`;
  const { ctx, root, entrypoint } = await deploySharedHost(transport, location.dir, identity, true);
  await ctx.exec('node', [
    '-e',
    "const fs=require('node:fs');const path=require('node:path');const [root,enabled]=process.argv.slice(1);fs.mkdirSync(root,{recursive:true,mode:0o700});const dest=path.join(root,'watch.json');const tmp=dest+'.'+require('node:crypto').randomUUID();const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({enabled:enabled==='true'}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,dest)",
    root,
    String(enabled),
  ]);
  if (!enabled) return;
  const config = await buildSharedHostConfig(
    {
      id: identity,
      agentId,
      providerId: agent.providerId,
      agentName: name ?? agent.name ?? undefined,
    },
    { sessionPath: location.dir, sessionEnvVars: {} },
    transport,
    { rooms: [], startCursor: 0 }
  );
  if (name && name !== agent.name) {
    const { stdout } = await ctx.exec('node', [
      '-e',
      "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).env.SWITCH_AGENT_ID)",
      config.execution!.credentialsPath,
    ]);
    const remoteId = stdout.trim();
    if (!remoteId || remoteId === 'undefined')
      throw new Error('Subagent Switch identity is missing.');
    config.session.agentId = remoteId;
  }
  await ctx.exec('node', [
    entrypoint,
    root,
    Buffer.from(JSON.stringify(config)).toString('base64'),
    '--ensure-watch',
    'false',
  ]);
}
