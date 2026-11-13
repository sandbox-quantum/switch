import { app } from 'electron';
import { appService } from '@main/core/app/service';
import { log } from '@main/lib/logger';
import {
  appUrlForChannelLink,
  browserUrlForChannelLink,
} from '@shared/core/switch-rooms/channel-links';
import { mattermostOriginFor } from './mattermost-origin';

/**
 * Open a room's bridged channel, or a bridge's workspace, outside Switch Console.
 *
 * Slack and Discord open in their desktop app when it is installed: neither app
 * picks up its web links, so the web address alone always lands in the browser.
 * Without the app, and for every other platform, open the web address for the
 * same channel — see {@link browserUrlForChannelLink}. Handing the app-only
 * link to a machine without the app is what once made this do nothing at all,
 * so the app's link is used only when the system names an app for its scheme.
 *
 * Lives in the main process because the origin a managed stack's Mattermost is
 * published on, and which apps are installed, are only known here.
 *
 * Throws when the channel cannot be opened, so the caller can say so. A link
 * that opens nothing is the failure this exists to stop repeating.
 */
export async function openRoomChannel(params: {
  serverId: string;
  channelUrl: string;
}): Promise<void> {
  const { serverId, channelUrl } = params;

  const appLink = appUrlForChannelLink(channelUrl);
  if (appLink && hasAppFor(appLink.scheme)) {
    await appService.openExternal(appLink.url);
    return;
  }

  const mattermostOrigin = channelUrl.startsWith('mattermost://')
    ? await mattermostOriginFor(serverId)
    : null;

  const target = browserUrlForChannelLink(channelUrl, mattermostOrigin);
  if (!target) {
    throw new Error(`No web address is known for this channel link: ${channelUrl}`);
  }

  await appService.openExternal(target);
}

/** Whether the system has an app registered for `scheme://` links. */
function hasAppFor(scheme: string): boolean {
  try {
    return app.getApplicationNameForProtocol(`${scheme}://`).trim() !== '';
  } catch (error) {
    log.warn(`Could not tell whether an app handles ${scheme}:// links`, error);
    return false;
  }
}
