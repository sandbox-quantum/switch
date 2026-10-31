import { describe, expect, it } from 'vitest';
import { browserUrlForChannelLink } from './channel-links';

describe('browserUrlForChannelLink', () => {
  it('addresses a Slack channel through the web client', () => {
    expect(browserUrlForChannelLink('slack://channel?team=T123&id=C456')).toBe(
      'https://app.slack.com/client/T123/C456'
    );
  });

  it('addresses a Slack workspace with no channel', () => {
    // The bridge-level "open the workspace" link, which names no channel.
    expect(browserUrlForChannelLink('slack://open?team=T123')).toBe(
      'https://app.slack.com/client/T123'
    );
  });

  it('gives up on a Slack link naming no workspace', () => {
    // The web client addresses a channel positionally under its workspace, so
    // a channel id alone cannot be turned into a URL.
    expect(browserUrlForChannelLink('slack://channel?id=C456')).toBeNull();
  });

  it('passes an https link through untouched', () => {
    // Discord and Teams already hand out web URLs their apps claim; they were
    // never broken and must not become a special case.
    expect(browserUrlForChannelLink('https://discord.com/channels/123/456')).toBe(
      'https://discord.com/channels/123/456'
    );
  });

  it('gives up on a scheme it does not know', () => {
    expect(browserUrlForChannelLink('zulip://stream/general')).toBeNull();
  });
});
