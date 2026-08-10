import { beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());
const mattermostOriginFor = vi.hoisted(() => vi.fn());
vi.mock('@main/core/app/service', () => ({ appService: { openExternal } }));
vi.mock('./mattermost-origin', () => ({ mattermostOriginFor }));

const { openRoomChannel } = await import('./open-channel');

describe('openRoomChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mattermostOriginFor.mockResolvedValue('http://127.0.0.1:51002');
    openExternal.mockResolvedValue(undefined);
  });

  it('opens a Mattermost channel on the origin switchdash reaches it on', async () => {
    // The deeplink itself only opens the desktop app; the web address opens
    // either way, which is the whole point of the fix.
    await openRoomChannel({
      serverId: 'srv-1',
      channelUrl: 'mattermost://mattermost:8065/switch/channels/town-square',
    });

    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:51002/switch/channels/town-square');
  });

  it('opens a Slack channel through the web client', async () => {
    await openRoomChannel({ serverId: 'srv-1', channelUrl: 'slack://channel?team=T1&id=C2' });

    expect(openExternal).toHaveBeenCalledWith('https://app.slack.com/client/T1/C2');
  });

  it('does not probe the Mattermost origin for another platform', async () => {
    await openRoomChannel({ serverId: 'srv-1', channelUrl: 'slack://channel?team=T1&id=C2' });

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
      openRoomChannel({ serverId: 'srv-1', channelUrl: 'zulip://stream/general' })
    ).rejects.toThrow(/zulip:\/\/stream\/general/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('propagates a failure to open so the caller can report it', async () => {
    // A silently discarded failure here is what made the broken link invisible.
    openExternal.mockRejectedValue(new Error('no handler'));

    await expect(
      openRoomChannel({ serverId: 'srv-1', channelUrl: 'slack://channel?team=T1&id=C2' })
    ).rejects.toThrow('no handler');
  });
});
