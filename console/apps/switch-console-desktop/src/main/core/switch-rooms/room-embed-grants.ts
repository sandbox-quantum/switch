/**
 * The room views the main process has prepared: each Mattermost partition it
 * signed in, and the origin it signed in to there. A `<webview>` the renderer
 * attaches has to name one of these and load from its origin
 * (`constrainGuest`), so markup cannot pick a session or a site of its own.
 */
const granted = new Map<string, string>();

export function grantRoomEmbed(partition: string, origin: string): void {
  granted.set(partition, origin);
}

/** The origin a prepared room view loads, or undefined for a partition never prepared. */
export function roomEmbedOrigin(partition: string): string | undefined {
  return granted.get(partition);
}
