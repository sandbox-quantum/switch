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
    ...overrides,
  };
}

describe('withResolvedHomeUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mattermostOriginFor.mockResolvedValue('http://127.0.0.1:8065');
  });

  it("uses switchdash's own origin for a managed stack's Mattermost", async () => {
    // The gateway reports the in-compose address, which resolves to nothing on
    // the user's machine. switchdash published the port, so it knows better.
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

  it('leaves other platforms on the server-built link', async () => {
    // Slack, Discord and Teams are public platforms — the gateway's URL is
    // correct everywhere, and switchdash has nothing better to offer.
    const resolved = await withResolvedHomeUrls(MANAGED, [
      bridge({ id: 'b2', type: 'slack', homeUrl: 'slack://open?team=T1' }),
      bridge({ id: 'b3', type: 'discord', homeUrl: null }),
    ]);

    expect(resolved[0].homeUrl).toBe('slack://open?team=T1');
    expect(resolved[1].homeUrl).toBeNull();
  });

  it('leaves a non-managed server untouched', async () => {
    // Somebody else's Mattermost: we neither run it nor know where it is
    // published, so the server's own answer is the only one available.
    const [resolved] = await withResolvedHomeUrls(EXTERNAL, [
      bridge({ homeUrl: 'mattermost://chat.example.com/switch' }),
    ]);

    expect(resolved.homeUrl).toBe('mattermost://chat.example.com/switch');
    expect(mattermostOriginFor).not.toHaveBeenCalled();
  });

  it('keeps the server link when the stack is not running', async () => {
    // No persisted ports (stack never started) means no origin to substitute.
    mattermostOriginFor.mockResolvedValue(null);

    const [resolved] = await withResolvedHomeUrls(MANAGED, [
      bridge({ homeUrl: 'mattermost://mattermost:8065/switch' }),
    ]);

    expect(resolved.homeUrl).toBe('mattermost://mattermost:8065/switch');
  });

  it('does not probe the stack when no Mattermost bridge is attached', async () => {
    await withResolvedHomeUrls(MANAGED, [bridge({ type: 'slack', homeUrl: null })]);

    expect(mattermostOriginFor).not.toHaveBeenCalled();
  });
});
