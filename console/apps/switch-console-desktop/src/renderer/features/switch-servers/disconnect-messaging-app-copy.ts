import type { BridgeInstallState } from '@shared/core/switch-servers/switch-servers';

/**
 * What disconnecting a messaging app actually does, which is not the same
 * action for every bridge.
 *
 * A bridge registered with credentials pasted into the connect form is
 * deleted, and every Switch room on it with it, which is why the dialog warns
 * about that in the strongest terms it has.
 *
 * A bridge backed by an install — Switch's own app added to a workspace, or
 * approved into a Microsoft organisation — is disconnected by ending the
 * install instead, which keeps its rooms as internal-only rooms. On the
 * distributed Teams app it also means Switch stops listening in the
 * organisation and leaves its teams, while removing the app from the
 * organisation entirely stays a Microsoft admin's job.
 *
 * A Switch Telegram app connection holds many chats, each an install of its
 * own; disconnecting it ends every chat, keeping each chat's room, and then
 * removes the connection.
 *
 * Until the install state is known, the strongest warning is shown: saying
 * rooms are kept when they are about to be deleted is the mistake that cannot
 * be taken back.
 */
export function disconnectMessagingAppParagraphs(params: {
  bridgeDisplayName: string;
  bridgeType: string;
  installState: BridgeInstallState | null;
}): string[] {
  const { bridgeDisplayName, bridgeType, installState } = params;
  if (installState === 'installed') {
    const kept = `The Switch rooms bridged to ${bridgeDisplayName} are not deleted — they become internal-only, reachable only from inside Switch.`;
    if (bridgeType === 'telegram') {
      return [
        `Every chat connected through ${bridgeDisplayName} is disconnected: the bot leaves each one, and each chat’s Switch room is kept as an internal-only room, reachable only from inside Switch. Then the connection itself is removed, which turns Telegram off for this workspace.`,
        'To stop a single chat instead, disconnect it from the list of chats under this connection.',
      ];
    }
    if (bridgeType === 'teams') {
      return [
        `Switch stops listening in this Microsoft organisation and leaves every team it was added to. ${kept}`,
        'Removing the app from the organisation entirely is a Microsoft admin’s job, done by hand in the Teams admin center and the Microsoft Entra admin center.',
      ];
    }
    return [`This ends Switch’s install in ${bridgeDisplayName}. ${kept}`];
  }
  return [
    'This deletes every Switch room on this app, along with their history, and then removes the connection. This can’t be undone.',
    `The channels in ${bridgeDisplayName} are not deleted — they stay where they are, with nothing bridging them to Switch.`,
  ];
}
