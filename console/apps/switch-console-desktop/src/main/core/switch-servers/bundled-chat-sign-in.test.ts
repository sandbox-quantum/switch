import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const mattermostOriginFor = vi.hoisted(() => vi.fn());
const readSecrets = vi.hoisted(() => vi.fn());

vi.mock('@main/core/switch-rooms/mattermost-origin', () => ({ mattermostOriginFor }));
vi.mock('@main/core/managed-switch-server/secrets', () => ({ readSecrets }));

const { bundledChatSignInFor } = await import('./bundled-chat-sign-in');

const MANAGED = {
  id: 'srv-1',
  managed: true,
  managementKind: 'local',
  sshHost: null,
} as SwitchServer;

const EXTERNAL = { id: 'srv-2', managed: false } as SwitchServer;

describe('bundledChatSignInFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mattermostOriginFor.mockResolvedValue('http://127.0.0.1:53012');
    readSecrets.mockResolvedValue({ mattermostUserPassword: 'generated-pw' });
  });

  it("reports the deployment's own port and generated password", async () => {
    // The whole point of the affordance: neither value is a documented default,
    // so both have to come from what this stack actually runs.
    const result = await bundledChatSignInFor(MANAGED);

    expect(result).toEqual({
      kind: 'available',
      url: 'http://127.0.0.1:53012',
      username: 'user',
      password: 'generated-pw',
    });
  });

  it('offers nothing for a server Switch Console does not run', async () => {
    const result = await bundledChatSignInFor(EXTERNAL);

    expect(result.kind).toBe('unavailable');
    // Nothing was even looked up — an external server has no local state to read.
    expect(mattermostOriginFor).not.toHaveBeenCalled();
    expect(readSecrets).not.toHaveBeenCalled();
  });

  it('says so when the stack has never started, rather than guessing a port', async () => {
    mattermostOriginFor.mockResolvedValue(null);

    const result = await bundledChatSignInFor(MANAGED);

    expect(result.kind).toBe('unavailable');
    expect(result).toMatchObject({ reason: expect.stringContaining('not started') });
  });

  it('says so when no credentials are stored', async () => {
    readSecrets.mockResolvedValue(null);

    const result = await bundledChatSignInFor(MANAGED);

    expect(result.kind).toBe('unavailable');
    expect(result).toMatchObject({ reason: expect.stringContaining('no stored credentials') });
  });

  it('treats a bundle missing the chat password as unavailable, not as an empty password', async () => {
    // A partial bundle would otherwise render as a blank password field, which
    // reads as "the password is empty" rather than "Switch Console cannot read it".
    readSecrets.mockResolvedValue({ dbPassword: 'x' });

    const result = await bundledChatSignInFor(MANAGED);

    expect(result.kind).toBe('unavailable');
  });

  it('never resolves to a server that is gone', async () => {
    const result = await bundledChatSignInFor(null);

    expect(result.kind).toBe('unavailable');
  });
});
