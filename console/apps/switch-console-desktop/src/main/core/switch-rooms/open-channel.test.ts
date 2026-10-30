import { beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());
vi.mock('@main/core/app/service', () => ({ appService: { openExternal } }));

const { openRoomChannel } = await import('./open-channel');

describe('openRoomChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openExternal.mockResolvedValue(undefined);
  });

  it('opens a Slack channel through the web client', async () => {
    await openRoomChannel('slack://channel?team=T1&id=C2');

    expect(openExternal).toHaveBeenCalledWith('https://app.slack.com/client/T1/C2');
  });

  it('opens a link that is already a web address unchanged', async () => {
    await openRoomChannel('https://discord.com/channels/123/456');

    expect(openExternal).toHaveBeenCalledWith('https://discord.com/channels/123/456');
  });

  it('refuses a link it cannot translate rather than opening nothing', async () => {
    await expect(openRoomChannel('zulip://stream/general')).rejects.toThrow(
      /zulip:\/\/stream\/general/
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('propagates a failure to open so the caller can report it', async () => {
    // A silently discarded failure here is what made the broken link invisible.
    openExternal.mockRejectedValue(new Error('no handler'));

    await expect(openRoomChannel('slack://channel?team=T1&id=C2')).rejects.toThrow('no handler');
  });
});
