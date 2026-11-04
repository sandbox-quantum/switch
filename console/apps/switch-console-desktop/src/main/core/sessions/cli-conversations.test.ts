import { beforeEach, expect, it, vi } from 'vitest';
import {
  discardCliConversationCopies,
  forkCliConversation,
  listCliConversations,
} from './cli-conversations';

const mocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getLocation: vi.fn(),
  runHostRequest: vi.fn(),
  resolveSessionEnv: vi.fn(),
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
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

let locations = 0;
/** An open location of its own, so what one test leaves to retry stays there. */
function newLocation() {
  locations += 1;
  return {
    locationId: `loc-${locations}`,
    dir: '/work',
    transport: { kind: 'local' },
    fs: {},
    settings: {},
  };
}
let location = newLocation();

function conversation(nativeSessionId: string) {
  return {
    nativeSessionId,
    title: nativeSessionId,
    lastActivityAt: 1,
    gitBranch: null,
    openIn: null,
  };
}

/** The requests the host was asked, in order: each command and the session it named. */
function asked(): [string, string | undefined][] {
  return mocks.runHostRequest.mock.calls.map(([, mode, request]) => [
    mode,
    (request as { consoleSessionId?: string }).consoleSessionId,
  ]);
}

/** Answers each host command with `answers[mode]`: a value is printed, an Error is thrown. */
function hostAnswers(answers: Record<string, unknown>) {
  mocks.runHostRequest.mockImplementation(async (_transport, mode: string) => {
    const answer = answers[mode];
    if (answer instanceof Error) throw answer;
    return { stdout: `${JSON.stringify(answer)}\n`, stderr: '' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  location = newLocation();
  mocks.getAgentById.mockResolvedValue({
    id: 'agent',
    locationId: location.locationId,
    providerId: 'claude',
  });
  mocks.getLocation.mockReturnValue(location);
  mocks.resolveSessionEnv.mockResolvedValue({
    sessionEnvVars: { SWITCHDASH_SESSION_ID: 'session-1' },
    shellSetup: 'export CLAUDE_CONFIG_DIR="$HOME/.claude-work"',
  });
});

it('lists the folder’s CLI conversations on its host without deploying, as the host gives them', async () => {
  mocks.runHostRequest.mockResolvedValue({
    stdout: `${JSON.stringify({ ownershipKnown: true, conversations: [conversation('cli-1')] })}\n`,
    stderr: '',
  });

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

it('copies with the session’s own environment, for the session to tag it with, deploying the host as a launch does', async () => {
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
      consoleSessionId: 'session-1',
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

it('removes the copies tagged as a session’s, reading the host without deploying', async () => {
  hostAnswers({ '--delete-cli-conversation-copies': { deleted: 1 } });
  await discardCliConversationCopies(location as never, 'session-1');
  expect(mocks.runHostRequest).toHaveBeenCalledWith(
    location.transport,
    '--delete-cli-conversation-copies',
    expect.objectContaining({ provider: 'claude', dir: '/work', consoleSessionId: 'session-1' }),
    { deploy: false, timeout: 60_000 }
  );
});

it('does not try again for a copy the host refused to make', async () => {
  hostAnswers({
    '--fork-cli-conversation': Object.assign(new Error('Command failed'), {
      stdout: `${JSON.stringify({ error: 'This conversation is open in Claude Code (process 41).' })}\n`,
    }),
    '--delete-cli-conversation-copies': { deleted: 0 },
    '--cli-conversations': { ownershipKnown: true, conversations: [] },
  });
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toThrow('open in Claude Code');
  await discardCliConversationCopies(location as never, 'session-1');
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('tries again with the next list for a copy whose outcome is unknown, until removing it succeeds', async () => {
  hostAnswers({
    '--fork-cli-conversation': new Error('Timed out after 120000ms'),
    '--delete-cli-conversation-copies': { deleted: 0 },
    '--cli-conversations': { ownershipKnown: true, conversations: [] },
  });
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toThrow('Timed out');
  // Removed at once, and again later: the copy may be made after Console
  // stopped waiting for it.
  await discardCliConversationCopies(location as never, 'session-1');
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  expect(asked()).toContainEqual(['--delete-cli-conversation-copies', 'session-1']);
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('tries again with the next copy in the location when removing a copy failed', async () => {
  hostAnswers({ '--delete-cli-conversation-copies': new Error('ssh: connection reset') });
  await discardCliConversationCopies(location as never, 'session-1');
  hostAnswers({
    '--delete-cli-conversation-copies': { deleted: 1 },
    '--fork-cli-conversation': { nativeSessionId: 'copy-2' },
  });
  mocks.runHostRequest.mockClear();
  await expect(
    forkCliConversation(location as never, { id: 'session-2', title: 'Fix' }, 'cli-1', true)
  ).resolves.toBe('copy-2');
  expect(asked()).toContainEqual(['--delete-cli-conversation-copies', 'session-1']);
  // Another location's copies are its own.
  const elsewhere = newLocation();
  mocks.runHostRequest.mockClear();
  hostAnswers({ '--delete-cli-conversation-copies': new Error('ssh: connection reset') });
  await discardCliConversationCopies(elsewhere as never, 'session-3');
  mocks.getAgentById.mockResolvedValue({
    id: 'agent',
    locationId: location.locationId,
    providerId: 'claude',
  });
  hostAnswers({ '--cli-conversations': { ownershipKnown: true, conversations: [] } });
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});
