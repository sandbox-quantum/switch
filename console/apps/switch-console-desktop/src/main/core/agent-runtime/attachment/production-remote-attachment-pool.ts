import { appSettingsService } from '@main/core/settings/settings-service';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { RemoteAttachmentPool } from './remote-attachment-pool';

/**
 * The app-wide attachment pool, wired to real settings and the real SSH
 * connection manager.
 *
 * The connection listener lives here — one for the whole app — replacing the
 * per-runtime listener each `SshAgentRuntime` used to register. That fan-out was
 * the reconnect storm: every session on a host re-attached in the same tick,
 * saturating the transport that had only just come back.
 */
export const remoteAttachmentPool = new RemoteAttachmentPool({
  readCap: async () => (await appSettingsService.get('remote')).maxAttachedSessionsPerHost,
});

sshConnectionManager.on('connection-event', (event) => {
  switch (event.type) {
    case 'disconnected':
    case 'reconnecting':
      remoteAttachmentPool.handleConnectionLost(event.connectionId);
      break;
    case 'reconnected':
      void remoteAttachmentPool.replayAfterReconnect(event.connectionId);
      break;
    default:
      break;
  }
});
