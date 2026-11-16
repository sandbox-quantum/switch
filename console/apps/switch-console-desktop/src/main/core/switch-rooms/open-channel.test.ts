import { beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());
const mattermostOriginFor = vi.hoisted(() => vi.fn());
const getApplicationNameForProtocol = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getApplicationNameForProtocol } }));
vi.mock('@main/core/app/service', () => ({ appService: { openExternal } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./mattermost-origin', () => ({ mattermostOriginFor }));

const { openRoomChannel } = await import('./open-channel');

describe('openRoomChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mattermostOriginFor.mockResolvedValue('http://127.0.0.1:51002');
    openExternal.mockResolvedValue(undefined);
    // No messaging app installed unless a test says so.
    getApplicationNameForProtocol.mockReturnValue('');
  });

  it('opens a Mattermost channel on the origin Switch Console reaches it on', async () => {
    // The deeplink itself only opens the desktop app; the web address opens
    // either way, which is the whole point of the fix.
    await openRoomChannel({
      serverId: 'srv-1',
      channelUrl: 'mattermost://mattermost:8065/switch/channels/town-square',
    });

    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:51002/switch/channels/town-square');
  });

  it('opens a Slack channel through the web client', async () => {
    await openRoomChannel({
      serverId: 'srv-1',
      channelUrl: 'slack://channel?team=T1&id=C2',
    });

    expect(openExternal).toHaveBeenCalledWith('https://app.slack.com/client/T1/C2');
  });

  it('does not probe the Mattermost origin for another platform', async () => {
    await openRoomChannel({
      serverId: 'srv-1',
      channelUrl: 'slack://channel?team=T1&id=C2',
    });

    expect(mattermostOriginFor).not.toHaveBeenCalled();
  });

  it('uses the host the deeplink names when no origin is known', async () => {
    // An external server's Mattermost — not ours to publish, but its deeplink
    // names the host the web app is served from.
    mattermostOriginFor.mockResolvedValue(null);

    await openRoomChannel({
      serverId: 'srv-2',
      channelUrl: 'mattermost://chat.example.com/switch/channels/x',
    });

    expect(openExternal).toHaveBeenCalledWith('https://chat.example.com/switch/channels/x');
  });

  it('opens a link that is already a web address unchanged', async () => {
    await openRoomChannel({
      serverId: 'srv-1',
      channelUrl: 'https://discord.com/channels/123/456',
    });

    expect(openExternal).toHaveBeenCalledWith('https://discord.com/channels/123/456');
  });

  it('refuses a link it cannot translate rather than opening nothing', async () => {
    await expect(
      openRoomChannel({
        serverId: 'srv-1',
        channelUrl: 'zulip://stream/general',
      })
    ).rejects.toThrow(/zulip:\/\/stream\/general/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('propagates a failure to open so the caller can report it', async () => {
    // A silently discarded failure here is what made the broken link invisible.
    openExternal.mockRejectedValue(new Error('no handler'));

    await expect(
      openRoomChannel({
        serverId: 'srv-1',
        channelUrl: 'slack://channel?team=T1&id=C2',
      })
    ).rejects.toThrow('no handler');
  });

  describe('with the desktop app installed', () => {
    beforeEach(() => {
      getApplicationNameForProtocol.mockImplementation((protocol: string) =>
        protocol === 'slack://' ? 'Slack' : protocol === 'discord://' ? 'Discord' : ''
      );
    });

    it('opens a Slack channel in the Slack app', async () => {
      // Slack's app does not claim its web links, so the web address would
      // land in the browser even with the app right there.
      await openRoomChannel({
        serverId: 'srv-1',
        channelUrl: 'slack://channel?team=T1&id=C2',
      });

      expect(openExternal).toHaveBeenCalledWith('slack://channel?team=T1&id=C2');
    });

    it('opens a Slack workspace link in the app, from its web form', async () => {
      await openRoomChannel({
        serverId: 'srv-1',
        channelUrl: 'https://app.slack.com/client/T1',
      });

      expect(openExternal).toHaveBeenCalledWith('slack://open?team=T1');
    });

    it('opens a Discord channel in the Discord app', async () => {
      await openRoomChannel({
        serverId: 'srv-1',
        channelUrl: 'https://discord.com/channels/123/456',
      });

      expect(openExternal).toHaveBeenCalledWith('discord://-/channels/123/456');
    });

    it('still opens Mattermost on the web', async () => {
      await openRoomChannel({
        serverId: 'srv-1',
        channelUrl: 'mattermost://mattermost:8065/switch/channels/town-square',
      });

      expect(openExternal).toHaveBeenCalledWith(
        'http://127.0.0.1:51002/switch/channels/town-square'
      );
    });
  });

  it('falls back to the web when it cannot tell whether the app is installed', async () => {
    getApplicationNameForProtocol.mockImplementation(() => {
      throw new Error('unsupported');
    });

    await openRoomChannel({
      serverId: 'srv-1',
      channelUrl: 'slack://channel?team=T1&id=C2',
    });

    expect(openExternal).toHaveBeenCalledWith('https://app.slack.com/client/T1/C2');
  });
});
