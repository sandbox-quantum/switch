/**
 * How a room's conversation can be shown inside switchdash.
 *
 * This is the seam CHOO-1674's Phase 0 was run to settle. Mattermost's
 * `/_popout/` route looked like the supported way to embed a single channel,
 * but it turns out to require the desktop app's `window.opener` token
 * handshake — under an Electron user agent the web app ignores our session
 * cookie and bounces to a login page. So we load the ordinary channel URL and
 * hide the surrounding chrome ourselves.
 *
 * Keeping the decision behind one resolved value means swapping strategies
 * later touches this module and nothing else.
 */

export type RoomEmbed =
  /**
   * Render the channel inline in a `<webview>`. `partition` already has the
   * Mattermost session cookie installed; `chromeless` asks the guest preload
   * to hide the global header and sidebars.
   */
  | {
      kind: 'inline';
      url: string;
      partition: string;
      chromeless: true;
    }
  /**
   * The room is bridged somewhere we cannot embed (Slack, or a Mattermost we
   * hold no credentials for). Offer the deeplink instead of pretending.
   */
  | { kind: 'external'; url: string; platform: string }
  /** Nothing to show, with a reason worth surfacing rather than a blank pane. */
  | { kind: 'unavailable'; reason: string };

/**
 * Mattermost deeplinks are `mattermost://<host>/<team>/channels/<name>`, which
 * a webview cannot load. Rewrite one onto the http(s) origin we actually serve
 * Mattermost from, preserving the team/channel path.
 *
 * Returns null rather than throwing: a malformed or non-Mattermost link is a
 * reason to fall back to the deeplink, not to fail the whole room view.
 */
export function channelUrlFromDeeplink(deeplink: string, mattermostOrigin: string): string | null {
  if (!deeplink.startsWith('mattermost://')) return null;
  try {
    // `new URL` on a custom scheme parses the authority as the host, so the
    // team/channel path is preserved verbatim after it.
    const parsed = new URL(deeplink);
    const path = parsed.pathname.replace(/^\/+/, '');
    if (!path) return null;
    return `${mattermostOrigin.replace(/\/+$/, '')}/${path}`;
  } catch {
    return null;
  }
}

/** Per-server partition, so each server's Mattermost session stays isolated. */
export function mattermostPartition(serverId: string): string {
  return `persist:switch-mattermost:${serverId}`;
}
