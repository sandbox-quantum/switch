import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { forceSshReconnect } from '@main/core/ssh/connect/connect-agent-ssh';
import { SshAuthError } from '@main/core/ssh/lifecycle/ssh-connection-manager';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { hostReachabilityEventChannel } from '@shared/core/remote-hosts/reachability';
import { HostReachabilityService } from './host-reachability-service';

/**
 * The reachability probe: rebuild the host's transport and run a trivial
 * command. `forceSshReconnect` rather than `ensureSshConnected` because a probe
 * must answer "can I reach this host *now*", not "is there a pooled connection
 * object" — a wedged connection would otherwise report success.
 */
async function probeHost(sshHost: string): Promise<void> {
  const proxy = await forceSshReconnect(sshConnectionIdForHost(sshHost), sshHost);
  await new SshExecutionContext(proxy).exec('uname', ['-s']);
}

export const hostReachabilityService = new HostReachabilityService({
  probe: probeHost,
  isAuthError: (error) => error instanceof SshAuthError,
  publish: (reachability) => events.emit(hostReachabilityEventChannel, reachability),
  log,
});
