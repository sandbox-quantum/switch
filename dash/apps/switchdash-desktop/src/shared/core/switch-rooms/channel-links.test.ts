import { describe, expect, it } from 'vitest';
import { browserUrlForChannelLink } from './channel-links';

describe('browserUrlForChannelLink', () => {
  it('rebases a Mattermost deeplink onto the origin switchdash reaches it on', () => {
    // A managed stack publishes Mattermost on a port switchdash chose, so the
    // host the gateway baked into the deeplink is not the one that works here.
    expect(
      browserUrlForChannelLink(
        'mattermost://mattermost:8065/switch/channels/town-square',
        'http://127.0.0.1:51002'
      )
    ).toBe('http://127.0.0.1:51002/switch/channels/town-square');
  });

  it('falls back to the host the Mattermost deeplink names', () => {
    // Somebody else's deployment: we do not run it and have no origin to
    // substitute, but the deeplink names the public host the web app serves.
    expect(
      browserUrlForChannelLink('mattermost://chat.example.com/switch/channels/town-square', null)
    ).toBe('https://chat.example.com/switch/channels/town-square');
  });

  it('serves a loopback Mattermost host over http', () => {
    // Inferring https for a local stack would fail the TLS handshake, which is
    // a worse failure than the one being fixed.
    expect(browserUrlForChannelLink('mattermost://localhost:8065/switch/channels/x', null)).toBe(
      'http://localhost:8065/switch/channels/x'
    );
  });

  it('maps a Mattermost workspace link with no channel path to the origin', () => {
    expect(browserUrlForChannelLink('mattermost://chat.example.com', null)).toBe(
      'https://chat.example.com'
    );
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(
      browserUrlForChannelLink('mattermost://host/switch/channels/x', 'http://127.0.0.1:8065/')
    ).toBe('http://127.0.0.1:8065/switch/channels/x');
  });

  it('addresses a Slack channel through the web client', () => {
    expect(browserUrlForChannelLink('slack://channel?team=T123&id=C456', null)).toBe(
      'https://app.slack.com/client/T123/C456'
    );
  });

  it('addresses a Slack workspace with no channel', () => {
    // The bridge-level "open the workspace" link, which names no channel.
    expect(browserUrlForChannelLink('slack://open?team=T123', null)).toBe(
      'https://app.slack.com/client/T123'
    );
  });

  it('gives up on a Slack link naming no workspace', () => {
    // The web client addresses a channel positionally under its workspace, so
    // a channel id alone cannot be turned into a URL.
    expect(browserUrlForChannelLink('slack://channel?id=C456', null)).toBeNull();
  });

  it('passes an https link through untouched', () => {
    // Discord and Teams already hand out web URLs their apps claim; they were
    // never broken and must not become a special case.
    expect(
      browserUrlForChannelLink('https://discord.com/channels/123/456', 'http://127.0.0.1:8065')
    ).toBe('https://discord.com/channels/123/456');
  });

  it('gives up on a scheme it does not know', () => {
    expect(browserUrlForChannelLink('zulip://stream/general', null)).toBeNull();
  });
});
