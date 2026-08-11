import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import type { SshConnectionManagerEvent } from '@main/core/ssh/lifecycle/ssh-connection-manager';
import { hostReachabilityService } from './production-host-reachability';

/** Reverse of `sshConnectionIdForHost`; null for ids the pool didn't mint for a host. */
function hostForConnectionId(connectionId: string): string | null {
  const prefix = 'agent-ssh:';
  return connectionId.startsWith(prefix) ? connectionId.slice(prefix.length) : null;
}

/**
 * Load persisted host reachability and bind the pooled SSH connection's
 * lifecycle into it, so state stays fresh from ordinary traffic rather than
 * only from probes.
 */
export async function initializeHostReachability(): Promise<void> {
  await hostReachabilityService.initialize();

  sshConnectionManager.on('connection-event', (event: SshConnectionManagerEvent) => {
    const sshHost = hostForConnectionId(event.connectionId);
    if (!sshHost) return;
    if (event.type === 'connected' || event.type === 'reconnected') {
      hostReachabilityService.handleSshConnectionEvent(sshHost, {
        type: event.type,
        connectionId: event.connectionId,
      });
      return;
    }
    if (event.type === 'reconnect-failed') {
      hostReachabilityService.handleSshConnectionEvent(sshHost, {
        type: 'reconnect-failed',
        connectionId: event.connectionId,
      });
      return;
    }
    if (event.type === 'error') {
      hostReachabilityService.handleSshConnectionEvent(sshHost, {
        type: 'error',
        connectionId: event.connectionId,
        errorMessage: event.error.message,
      });
    }
  });
}
