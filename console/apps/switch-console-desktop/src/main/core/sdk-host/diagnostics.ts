import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { fetchSdkSessions } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';

const inspect = `
const fs=require('node:fs'), path=require('node:path');
const directory=path.join(require('node:os').homedir(),'.local','state','switch','sdk-watchers');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}};
const live=p=>{if(!p)return false;if(!Number.isSafeInteger(p)||p<=0)throw new Error('Invalid host PID');try{process.kill(p,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}};
const result=[];
if(fs.existsSync(directory))for(const name of fs.readdirSync(directory)){
 const root=path.join(directory,name),config=read(path.join(root,'config.json'));
 if(config?.session.agentId!==process.argv[1])continue;
 const running=live(read(path.join(root,'shared-owner.lock'))?.pid);
 result.push({running,enabled:read(path.join(root,'watch.json'))?.enabled??false,failure:running?null:read(path.join(root,'supervisor','failure.json'))?.message??null});
}
console.log(JSON.stringify(result));
`;
export async function sharedAgentDiagnostics(agentId: string) {
  const agent = await getAgentById(agentId);
  if (!agent?.serverId || !agent.switchAgentId)
    throw new Error('The agent is not linked to Switch.');
  const location = await getAgentLocation(agent);
  const ctx = location.sshHost
    ? (await connectRemoteAgent(agent)).ctx
    : new LocalExecutionContext();
  const server = await getServer(agent.serverId);
  if (!server) throw new Error('The agent’s Switch server is missing.');
  const [host, remote] = await Promise.all([
    ctx.exec('node', ['-e', inspect, agent.switchAgentId]),
    fetchSdkSessions(server),
  ]);
  return {
    watchers: z
      .array(
        z.object({ running: z.boolean(), enabled: z.boolean(), failure: z.string().nullable() })
      )
      .parse(JSON.parse(host.stdout)),
    sessions: sessionSchema
      .array()
      .parse(remote)
      .filter((session) => session.agentId === agent.switchAgentId),
  };
}
