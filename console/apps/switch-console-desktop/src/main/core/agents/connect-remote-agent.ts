import type { SidecarHost } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import type { Agent } from '@shared/core/agents/agents';
import { getRemoteAgentLocation } from './agent-location';

function createSidecarHost(
  ctx: IExecutionContext,
  proxy: SshClientProxy,
  remoteRepoDir: string
): SidecarHost {
  return {
    exec: (command, args) => ctx.exec(command, args),
    // SFTP channels do not self-close and this host object can be held for a
    // long time (the reconciler, the watcher) — open a throwaway filesystem
    // per transfer and close it, or every sidecar deploy leaks a channel.
    putFile: async (localAbsPath, remoteRelPath) => {
      const fs = new SshFileSystem(proxy, remoteRepoDir);
      try {
        await fs.copyLocalFile(localAbsPath, remoteRelPath);
      } finally {
        fs.close();
      }
    },
  };
}

/** Resolve the SSH execution context + a host seam + proxy for an agent at a remote location, or throw. */
export async function connectRemoteAgent(agent: Agent): Promise<{
  ctx: IExecutionContext;
  connectionId: string;
  remoteRepoDir: string;
  host: SidecarHost;
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
    host: createSidecarHost(ctx, proxy, location.dir),
    proxy,
  };
}
