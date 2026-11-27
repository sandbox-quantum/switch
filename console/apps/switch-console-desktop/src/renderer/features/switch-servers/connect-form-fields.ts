import type { MessagingAppWords } from '@switch-console/chat-ui/components/connect-messaging-app';
import { privateAddress } from '@switch-console/chat-ui/model/connect-messaging-app';
import { runsOnThisComputer, type SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Whether Microsoft could not reach this server, so Teams, which delivers
 * every message to the server's own address, cannot work with it: one Switch
 * Console runs on this computer, or one at a loopback, private or `.local`
 * address.
 */
export function unreachableFromInternet(
  server: Pick<SwitchServer, 'managed' | 'managementKind' | 'url'>
): boolean {
  return runsOnThisComputer(server) || privateAddress(server.url);
}

/** How Console names Switch and what is added to it, in the connect dialog. */
export const CONSOLE_MESSAGING_APP_WORDS: MessagingAppWords = {
  thisServer: 'this server',
  thisSwitchServers: 'this Switch server’s',
  yourServers: 'your server’s',
  currentDefault: 'the server’s current default',
  onTheServer: 'on the server',
  connection: 'connection',
  appName: 'Switch Console',
};
