/**
 * Translating a bridge's channel link into one that opens anywhere.
 *
 * Each bridge hands out whichever link its platform prefers. Discord, Teams and
 * Telegram use ordinary https URLs, which their desktop clients register for —
 * the app catches them when installed, the browser serves them when not.
 * Mattermost and
 * Slack instead use a private scheme that only their desktop app answers, so on
 * a machine without that app the click reaches nobody and nothing happens.
 *
 * Both of those have a web address for the same channel, so build that instead.
 * It is the one form that opens anywhere.
 *
 * The web form is only the fallback, though. Slack's and Discord's desktop apps
 * do not pick up their web links, so opening one always lands in the browser
 * even with the app installed. {@link appUrlForChannelLink} gives the link the
 * app itself answers, for the caller to use when that app is installed.
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

/** Discord's web client, whose `/channels/…` paths its desktop app also takes. */
const DISCORD_CHANNELS = /^https:\/\/(?:www\.)?discord\.com(\/channels\/[^?#]*)/i;

/** Slack's web client path for a workspace, optionally followed by a channel. */
const SLACK_WEB_CLIENT_PATH = /^https:\/\/app\.slack\.com\/client\/([^/?#]+)(?:\/([^/?#]+))?/i;

/**
 * The link the platform's desktop app answers for a bridge channel or workspace
 * link, with the URL scheme that app registers, or null for a platform whose
 * app already picks up its web links (or that we do not know).
 *
 * Accepts either form a link reaches Console in: the bridge's own, or the web
 * address {@link browserUrlForChannelLink} made from it. Only open the result
 * when the app is installed: nothing else answers these schemes.
 */
export function appUrlForChannelLink(
  link: string
): { scheme: 'slack' | 'discord'; url: string } | null {
  if (link.startsWith('slack://')) return { scheme: 'slack', url: link };

  const slack = SLACK_WEB_CLIENT_PATH.exec(link);
  if (slack) {
    const [, team, channel] = slack;
    return {
      scheme: 'slack',
      url: channel ? `slack://channel?team=${team}&id=${channel}` : `slack://open?team=${team}`,
    };
  }

  const discord = DISCORD_CHANNELS.exec(link);
  // `discord://-/` is the authority Discord's own "open in app" links use.
  if (discord) return { scheme: 'discord', url: `discord://-${discord[1]}` };

  return null;
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
