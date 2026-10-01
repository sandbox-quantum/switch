/**
 * What disconnecting a messaging app actually does, which is not the same
 * action for every bridge.
 *
 * An ordinary bridge is registered with credentials pasted into the connect
 * form; disconnecting it deletes every Switch room that lived on it, which is
 * why the dialog warns about that in the strongest terms it has.
 *
 * A distributed Teams connection is different: it exists because a Microsoft
 * admin approved Switch's own app into the organisation, and disconnecting it
 * only ends that approval. Switch stops listening there and leaves every team
 * it was added to, but the Switch rooms bridged to it are not deleted — they
 * become internal-only. Saying the ordinary copy here would overstate the
 * damage; saying nothing would understate it, since the app still has to be
 * removed from the organisation by hand.
 */
export function disconnectMessagingAppParagraphs(params: {
  bridgeDisplayName: string;
  teamPlacementSupported: boolean;
}): string[] {
  const { bridgeDisplayName, teamPlacementSupported } = params;
  if (teamPlacementSupported) {
    return [
      `Switch stops listening in this Microsoft organisation and leaves every team it was added to. The Switch rooms bridged to ${bridgeDisplayName} are not deleted — they become internal-only, reachable only from inside Switch.`,
      'Removing the app from the organisation entirely is a Microsoft admin’s job, done by hand in the Teams admin center and the Microsoft Entra admin center.',
    ];
  }
  return [
    'This deletes every Switch room on this app, along with their history, and then removes the connection. This can’t be undone.',
    `The channels in ${bridgeDisplayName} are not deleted — they stay where they are, with nothing bridging them to Switch.`,
  ];
}
