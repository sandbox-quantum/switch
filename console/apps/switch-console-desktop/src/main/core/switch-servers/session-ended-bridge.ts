import { events } from '@main/lib/events';
import { gatewaySessionEndedChannel } from '@shared/events/switchServerEvents';
import { onSessionEnded } from './session-ended';

/** Forward {@link onSessionEnded} to the window, which re-checks the server's sign-in. */
export function bridgeSessionEndedToRenderer(): void {
  onSessionEnded((serverId) => events.emit(gatewaySessionEndedChannel, { serverId }));
}
