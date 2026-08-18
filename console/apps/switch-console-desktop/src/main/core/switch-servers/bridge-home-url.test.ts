import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteBridge, SwitchServer } from '@shared/core/switch-servers/switch-servers';

const mattermostOriginFor = vi.hoisted(() => vi.fn());
vi.mock('@main/core/switch-rooms/mattermost-origin', () => ({ mattermostOriginFor }));

const { withResolvedHomeUrls } = await import('./bridge-home-url');

const MANAGED = { id: 'srv-1', managed: true } as SwitchServer;
const EXTERNAL = { id: 'srv-2', managed: false } as SwitchServer;

function bridge(overrides: Partial<RemoteBridge>): RemoteBridge {
  return {
    id: 'b1',
    type: 'mattermost',
    displayName: 'Mattermost',
    status: 'active',
    isDefault: true,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
    ...overrides,
  };
}

describe('withResolvedHomeUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mattermostOriginFor.mockResolvedValue('http://127.0.0.1:8065');
  });

  it("uses Switch Console's own origin for a managed stack's Mattermost", async () => {
    // The gateway reports the in-compose address, which resolves to nothing on
    // the user's machine. Switch Console published the port, so it knows better.
    const [resolved] = await withResolvedHomeUrls(MANAGED, [
      bridge({ homeUrl: 'mattermost://mattermost:8065/switch' }),
    ]);

    expect(resolved.homeUrl).toBe('http://127.0.0.1:8065/switch');
  });

  it('supplies a link even when the server offers none', async () => {
    // The gateway only gained `home_url` after the currently pinned
    // switch-core, so a managed stack returns null until the pin bumps. The
    // bundled Mattermost still opens, because nothing here needed its answer.
    const [resolved] = await withResolvedHomeUrls(MANAGED, [bridge({ homeUrl: null })]);

    expect(resolved.homeUrl).toBe('http://127.0.0.1:8065/switch');
  });

  it('puts a Slack workspace link in web form', async () => {
    // `slack://` reaches nobody on a machine without the desktop app, which is
    // the same defect the per-room channel action had.
    const [resolved] = await withResolvedHomeUrls(MANAGED, [
      bridge({ id: 'b2', type: 'slack', homeUrl: 'slack://open?team=T1' }),
    ]);

    expect(resolved.homeUrl).toBe('https://app.slack.com/client/T1');
  });

  it('leaves a platform that already hands out a web link alone', async () => {
    // Discord and Teams use https URLs their apps claim, so there is nothing to
    // translate and they must not become a special case.
    const resolved = await withResolvedHomeUrls(MANAGED, [
      bridge({ id: 'b3', type: 'discord', homeUrl: 'https://discord.com/channels/123' }),
      bridge({ id: 'b4', type: 'teams', homeUrl: null }),
    ]);

    expect(resolved[0].homeUrl).toBe('https://discord.com/channels/123');
    expect(resolved[1].homeUrl).toBeNull();
  });

  it('reaches a non-managed Mattermost on the host its link names', async () => {
    // Somebody else's Mattermost: we do not run it and cannot substitute an
    // origin, but its deeplink names the public host the web app serves.
    const [resolved] = await withResolvedHomeUrls(EXTERNAL, [
      bridge({ homeUrl: 'mattermost://chat.example.com/switch' }),
    ]);

    expect(resolved.homeUrl).toBe('https://chat.example.com/switch');
    expect(mattermostOriginFor).not.toHaveBeenCalled();
  });

  it('still hands back a web link when the stack is not running', async () => {
    // No persisted ports (stack never started) means no origin to substitute,
    // so the in-compose host is all there is and the link cannot work either
    // way. Web form at least fails in the browser where the user can see it,
    // rather than reaching no handler at all.
    mattermostOriginFor.mockResolvedValue(null);

    const [resolved] = await withResolvedHomeUrls(MANAGED, [
      bridge({ homeUrl: 'mattermost://mattermost:8065/switch' }),
    ]);

    expect(resolved.homeUrl).toBe('https://mattermost:8065/switch');
  });

  it('does not probe the stack when no Mattermost bridge is attached', async () => {
    await withResolvedHomeUrls(MANAGED, [bridge({ type: 'slack', homeUrl: null })]);

    expect(mattermostOriginFor).not.toHaveBeenCalled();
  });
});
