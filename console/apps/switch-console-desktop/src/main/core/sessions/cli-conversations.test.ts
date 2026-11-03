import { beforeEach, expect, it, vi } from 'vitest';
import { forkCliConversation, listCliConversations } from './cli-conversations';

const mocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getLocation: vi.fn(),
  runHostRequest: vi.fn(),
  resolveSessionEnv: vi.fn(),
  sessionConfigs: vi.fn(),
}));

vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.getAgentById }));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { getLocation: mocks.getLocation },
}));
vi.mock('@main/core/locations/location-runtime-factory', () => ({
  resolveSessionEnv: mocks.resolveSessionEnv,
}));
vi.mock('@main/core/sdk-host/shared-host-deployment', () => ({
  runHostRequest: mocks.runHostRequest,
}));
vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: () => mocks.sessionConfigs() }) }),
    }),
  },
}));

const location = { dir: '/work', transport: { kind: 'local' }, fs: {}, settings: {} };

function conversation(nativeSessionId: string) {
  return {
    nativeSessionId,
    title: nativeSessionId,
    lastActivityAt: 1,
    gitBranch: null,
    openIn: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentById.mockResolvedValue({ id: 'agent', locationId: 'loc', providerId: 'claude' });
  mocks.getLocation.mockReturnValue(location);
  mocks.sessionConfigs.mockResolvedValue([]);
  mocks.resolveSessionEnv.mockResolvedValue({
    sessionEnvVars: { SWITCHDASH_SESSION_ID: 'session-1' },
    shellSetup: 'export CLAUDE_CONFIG_DIR="$HOME/.claude-work"',
  });
});

it('lists the folder’s CLI conversations on its host without deploying, leaving out the copies Console already runs', async () => {
  mocks.runHostRequest.mockResolvedValue({
    stdout: `${JSON.stringify({
      ownershipKnown: true,
      conversations: [conversation('cli-1'), conversation('copy-1')],
    })}\n`,
    stderr: '',
  });
  mocks.sessionConfigs.mockResolvedValue([
    { config: { providerSessionId: 'copy-1' } },
    { config: null },
  ]);

  const result = await listCliConversations('agent');

  expect(mocks.runHostRequest).toHaveBeenCalledWith(
    location.transport,
    '--cli-conversations',
    expect.objectContaining({
      provider: 'claude',
      dir: '/work',
      shellSetup: 'export CLAUDE_CONFIG_DIR="$HOME/.claude-work"',
      inheritEnv: expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'HOME']),
    }),
    { deploy: false, timeout: 60_000 }
  );
  expect(result).toEqual({
    success: true,
    data: { ownershipKnown: true, conversations: [conversation('cli-1')] },
  });
});

it('offers nothing for an agent that is not Claude Code', async () => {
  mocks.getAgentById.mockResolvedValue({ id: 'agent', locationId: 'loc', providerId: 'codex' });
  const result = await listCliConversations('agent');
  expect(result).toEqual({
    success: false,
    error: { message: 'Only Claude Code agents can continue a conversation started in its CLI.' },
  });
  expect(mocks.runHostRequest).not.toHaveBeenCalled();
});

it('copies with the session’s own environment, deploying the host as a launch does', async () => {
  mocks.runHostRequest.mockResolvedValue({ stdout: '{"nativeSessionId":"copy-2"}\n', stderr: '' });
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).resolves.toBe('copy-2');
  expect(mocks.resolveSessionEnv).toHaveBeenCalledWith(
    { id: 'session-1', title: 'Fix' },
    { path: '/work', fs: location.fs },
    location.settings
  );
  expect(mocks.runHostRequest).toHaveBeenCalledWith(
    location.transport,
    '--fork-cli-conversation',
    expect.objectContaining({
      env: { SWITCHDASH_SESSION_ID: 'session-1' },
      nativeSessionId: 'cli-1',
      confirmedClosed: true,
    }),
    { deploy: true, timeout: 120_000 }
  );
});

it('throws the reason the host gave for refusing a copy, not that its command failed', async () => {
  mocks.runHostRequest.mockRejectedValue(
    Object.assign(new Error('Command failed'), {
      stdout: `${JSON.stringify({ error: 'This conversation is open in Claude Code (process 41). Close it there, then try again.' })}\n`,
    })
  );
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toThrow('This conversation is open in Claude Code (process 41)');
});

it('passes on a failure the host did not explain', async () => {
  const failure = new Error('ssh: connection refused');
  mocks.runHostRequest.mockRejectedValue(failure);
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toBe(failure);
});
