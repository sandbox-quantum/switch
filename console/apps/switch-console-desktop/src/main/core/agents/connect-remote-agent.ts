import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import type { Agent } from '@shared/core/agents/agents';
import { getRemoteAgentLocation } from './agent-location';

export async function connectRemoteAgent(agent: Agent): Promise<{
  ctx: IExecutionContext;
  connectionId: string;
  remoteRepoDir: string;
  proxy: SshClientProxy;
}> {
  const location = await getRemoteAgentLocation(agent);
  if (!location) {
    throw new Error(`agent ${agent.id} is not at a remote location`);
  }
  const connectionId = sshConnectionIdForHost(location.sshHost);
  const proxy = await ensureSshConnected(connectionId, location.sshHost);
  const ctx = new SshExecutionContext(proxy, { root: location.dir });
  return {
    ctx,
    connectionId,
    remoteRepoDir: location.dir,
    proxy,
  };
}
