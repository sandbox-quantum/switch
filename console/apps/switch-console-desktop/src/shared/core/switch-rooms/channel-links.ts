/**
 * Translating a bridge's channel link into one that opens anywhere.
 *
 * Each bridge hands out whichever link its platform prefers. Discord, Teams and
 * Telegram use ordinary https URLs, which their desktop clients register for —
 * the app catches them when installed, the browser serves them when not.
 * Slack instead uses a private scheme that only its desktop app answers, so on
 * a machine without that app the click reaches nobody and nothing happens.
 *
 * Slack has a web address for the same channel, so build that instead.
 * It is the one form that works either way: an installed app still claims its
 * own web links, and a machine without one falls back to the browser.
 */

/** Slack's web client, where a workspace/channel pair addresses a channel. */
const SLACK_WEB_CLIENT = 'https://app.slack.com/client';

/**
 * The web address for a bridge channel or workspace link, or null when the link
 * is not one we know how to translate.
 */
export function browserUrlForChannelLink(link: string): string | null {
  if (/^https?:\/\//i.test(link)) return link;
  if (link.startsWith('slack://')) return slackWebUrl(link);
  return null;
}

/**
 * `slack://channel?team=<workspace>&id=<channel>` names the workspace and
 * channel that Slack's web client addresses positionally. The workspace alone
 * still resolves — that is the shape of the bridge-level "open the workspace"
 * link — but a channel id without one does not.
 */
function slackWebUrl(deeplink: string): string | null {
  const parsed = parseDeeplink(deeplink);
  if (!parsed) return null;

  const team = parsed.searchParams.get('team');
  if (!team) return null;

  const channel = parsed.searchParams.get('id');
  return channel ? `${SLACK_WEB_CLIENT}/${team}/${channel}` : `${SLACK_WEB_CLIENT}/${team}`;
}

function parseDeeplink(deeplink: string): URL | null {
  try {
    // `new URL` on a custom scheme parses the authority as the host, leaving
    // the path and query after it verbatim.
    return new URL(deeplink);
  } catch {
    return null;
  }
}
