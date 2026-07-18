import type { SidecarHost } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { agentSshConnectionId } from '@main/core/workspaces/resolve-agent-workspace';
import type { Agent } from '@shared/core/agents/agents';

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

/** Resolve the SSH execution context + a host seam + proxy for a remote agent, or throw if not remote. */
export async function connectRemoteAgent(agent: Agent): Promise<{
  ctx: IExecutionContext;
  connectionId: string;
  remoteRepoDir: string;
  host: SidecarHost;
  proxy: SshClientProxy;
}> {
  if (agent.connection !== 'remote' || !agent.remoteConfig) {
    throw new Error(`agent ${agent.id} is not configured to run remotely`);
  }
  const { sshHost, remoteRepoDir } = agent.remoteConfig;
  const connectionId = agentSshConnectionId(sshHost);
  const proxy = await ensureSshConnected(connectionId, sshHost);
  const ctx = new SshExecutionContext(proxy, { root: remoteRepoDir });
  return {
    ctx,
    connectionId,
    remoteRepoDir,
    host: createSidecarHost(ctx, proxy, remoteRepoDir),
    proxy,
  };
}
