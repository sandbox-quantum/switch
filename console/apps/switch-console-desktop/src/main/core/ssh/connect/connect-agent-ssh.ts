import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { registerSshResolver } from './ssh-resolver';

/**
 * Establish (or reuse) the pooled connection to a host, gated on the host's
 * modeled reachability.
 *
 * This is the single funnel every remote capability goes through — exec
 * contexts, SFTP, terminals, PTYs, sidecar deploys, dependency probes, the
 * managed server — so gating here is what centralizes reachability for all of
 * them (CHOO-1682). A host known to be unreachable fails fast with the modeled
 * reason instead of each caller rediscovering it through a 20s SSH timeout, and
 * every real connect outcome feeds the shared host state so ordinary traffic
 * keeps it fresh without extra probes.
 */
export async function ensureSshConnected(
  connectionId: string,
  sshHost: string
): Promise<SshClientProxy> {
  hostReachabilityService.requireReachable(sshHost);
  registerSshResolver(connectionId, sshHost);
  try {
    const proxy = await sshConnectionManager.connect(connectionId);
    hostReachabilityService.reportSuccess(sshHost);
    return proxy;
  } catch (error) {
    hostReachabilityService.reportFailure(sshHost, error);
    throw error;
  }
}

/**
 * Force a full transport rebuild for a host's pooled connection — the manual
 * recovery path behind the UI's refresh. Deliberately NOT gated on
 * reachability: forcing a reconnect is how an unreachable host gets retried.
 */
export async function forceSshReconnect(
  connectionId: string,
  sshHost: string
): Promise<SshClientProxy> {
  registerSshResolver(connectionId, sshHost);
  return sshConnectionManager.forceReconnect(connectionId);
}
