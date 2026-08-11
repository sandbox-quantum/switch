/**
 * Translating a bridge's channel link into one that opens anywhere.
 *
 * Each bridge hands out whichever link its platform prefers. Discord and Teams
 * use ordinary https URLs, which their desktop clients register for — the app
 * catches them when installed, the browser serves them when not. Mattermost and
 * Slack instead use a private scheme that only their desktop app answers, so on
 * a machine without that app the click reaches nobody and nothing happens.
 *
 * Both of those have a web address for the same channel, so build that instead.
 * It is the one form that works either way: an installed app still claims its
 * own web links, and a machine without one falls back to the browser.
 */

/** Slack's web client, where a workspace/channel pair addresses a channel. */
const SLACK_WEB_CLIENT = 'https://app.slack.com/client';

/**
 * Hosts served over plain http. A deeplink carries a host but no scheme, so the
 * scheme has to be inferred when we have no better origin to graft it onto;
 * loopback is a local stack, anything else is a real deployment on https.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * The web address for a bridge channel or workspace link, or null when the link
 * is not one we know how to translate.
 *
 * `mattermostOrigin` is where Switch Console can actually reach this server's
 * Mattermost, which it only knows for stacks it runs itself. Pass null
 * otherwise and the host named by the deeplink is used.
 */
export function browserUrlForChannelLink(
  link: string,
  mattermostOrigin: string | null
): string | null {
  if (/^https?:\/\//i.test(link)) return link;
  if (link.startsWith('mattermost://')) return mattermostWebUrl(link, mattermostOrigin);
  if (link.startsWith('slack://')) return slackWebUrl(link);
  return null;
}

/**
 * `mattermost://<host>/<team>/channels/<name>` addresses the same path the web
 * app serves, so only the origin has to change.
 */
function mattermostWebUrl(deeplink: string, mattermostOrigin: string | null): string | null {
  const parsed = parseDeeplink(deeplink);
  if (!parsed) return null;

  const origin = mattermostOrigin?.replace(/\/+$/, '') ?? webOriginOf(parsed);
  if (!origin) return null;

  const path = parsed.pathname.replace(/^\/+/, '');
  return path ? `${origin}/${path}` : origin;
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

function webOriginOf(parsed: URL): string | null {
  if (!parsed.host) return null;
  const scheme = LOOPBACK_HOSTS.has(parsed.hostname) ? 'http' : 'https';
  return `${scheme}://${parsed.host}`;
}
