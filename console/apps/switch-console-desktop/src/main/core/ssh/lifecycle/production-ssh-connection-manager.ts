import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sshConnectionEventChannel } from '@shared/core/ssh/sshEvents';
import { SshConnectionManager } from './ssh-connection-manager';

export const sshConnectionManager = new SshConnectionManager({
  publishEvent: (event) => events.emit(sshConnectionEventChannel, event),
  log,
});
