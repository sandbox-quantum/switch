import { MAX_SESSIONS_PER_REQUEST } from '@switch-console/agent-providers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  discardCliConversationCopies,
  forkCliConversation,
  HostRefusedError,
  listCliConversations,
} from './cli-conversations';

const mocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getLocation: vi.fn(),
  runHostRequest: vi.fn(),
  resolveSessionEnv: vi.fn(),
  warn: vi.fn(),
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
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: mocks.warn } }));

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

/** The requests the host was asked, in order: each command and the sessions it named. */
function asked(): [string, string | string[] | undefined][] {
  return mocks.runHostRequest.mock.calls.map(([, mode, request]) => {
    const { consoleSessionId, consoleSessionIds } = request as {
      consoleSessionId?: string;
      consoleSessionIds?: string[];
    };
    return [mode, consoleSessionIds ?? consoleSessionId];
  });
}

/**
 * Answers each host command with `answers[mode]`: a value is printed, an Error
 * is thrown, and a promise is waited for first.
 */
function hostAnswers(answers: Record<string, unknown>) {
  mocks.runHostRequest.mockImplementation(async (_transport, mode: string) => {
    const answer = await answers[mode];
    if (answer instanceof Error) throw answer;
    return { stdout: `${JSON.stringify(answer)}\n`, stderr: '' };
  });
}

/**
 * Answers a list with no conversations, and a removal with one copy found for
 * each session it names, but fails a removal that names `failing`.
 */
function hostRemovesCopies(failing: string | null) {
  mocks.runHostRequest.mockImplementation(
    async (_transport, mode: string, request: { consoleSessionIds?: string[] }) => {
      if (mode === '--cli-conversations')
        return { stdout: '{"ownershipKnown":true,"conversations":[]}\n', stderr: '' };
      const sessionIds = request.consoleSessionIds ?? [];
      if (failing !== null && sessionIds.includes(failing))
        throw new Error('ssh: connection reset');
      const deleted = Object.fromEntries(sessionIds.map((id) => [id, 1]));
      return { stdout: `${JSON.stringify({ deleted })}\n`, stderr: '' };
    }
  );
}

/** Ids for `count` sessions, in order. */
function sessionIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `session-${index + 1}`);
}

/** What the host prints for a copy it refused to make. */
function refusal(error: string) {
  return Object.assign(new Error('Command failed'), {
    stdout: `${JSON.stringify({ error })}\n`,
  });
}

/** Lets the removals a list or copy started in the background finish. */
function removalsSettle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
});

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
    refusal(
      'This conversation is open in Claude Code (process 41). Close it there, then try again.'
    )
  );
  const copied = forkCliConversation(
    location as never,
    { id: 'session-1', title: 'Fix' },
    'cli-1',
    true
  );
  await expect(copied).rejects.toThrow('This conversation is open in Claude Code (process 41)');
  await expect(copied).rejects.toBeInstanceOf(HostRefusedError);
});

it('passes on a failure the host did not explain', async () => {
  const failure = new Error('ssh: connection refused');
  mocks.runHostRequest.mockRejectedValue(failure);
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toBe(failure);
});

it('removes the copies tagged as a session’s, reading the host without deploying', async () => {
  hostAnswers({ '--delete-cli-conversation-copies': { deleted: { 'session-1': 1 } } });
  await discardCliConversationCopies(location as never, 'session-1');
  expect(mocks.runHostRequest).toHaveBeenCalledWith(
    location.transport,
    '--delete-cli-conversation-copies',
    expect.objectContaining({ provider: 'claude', dir: '/work', consoleSessionIds: ['session-1'] }),
    { deploy: false, timeout: 60_000 }
  );
  mocks.runHostRequest.mockClear();
  hostAnswers({ '--cli-conversations': { ownershipKnown: true, conversations: [] } });
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('does not try again for a copy the host refused to make', async () => {
  hostAnswers({
    '--fork-cli-conversation': refusal('This conversation is open in Claude Code (process 41).'),
    '--delete-cli-conversation-copies': { deleted: { 'session-1': 0 } },
    '--cli-conversations': { ownershipKnown: true, conversations: [] },
  });
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toThrow('open in Claude Code');
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('keeps trying, with each list, to remove a copy whose outcome is unknown until a removal finds it', async () => {
  hostAnswers({
    '--fork-cli-conversation': new Error('Timed out after 120000ms'),
    '--delete-cli-conversation-copies': { deleted: { 'session-1': 0 } },
    '--cli-conversations': { ownershipKnown: true, conversations: [] },
  });
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toThrow('Timed out');
  // Found nothing: the copy may still be being made on the host.
  await discardCliConversationCopies(location as never, 'session-1');
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toContainEqual(['--delete-cli-conversation-copies', ['session-1']]);
  hostAnswers({
    '--delete-cli-conversation-copies': { deleted: { 'session-1': 1 } },
    '--cli-conversations': { ownershipKnown: true, conversations: [] },
  });
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toContainEqual(['--delete-cli-conversation-copies', ['session-1']]);
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('stops looking for a copy no removal found, long after its outcome became unknown, and says so', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'));
  hostAnswers({
    '--fork-cli-conversation': new Error('Timed out after 120000ms'),
    '--delete-cli-conversation-copies': { deleted: { 'session-1': 0 } },
    '--cli-conversations': { ownershipKnown: true, conversations: [] },
  });
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toThrow('Timed out');
  vi.setSystemTime(new Date('2026-11-04T10:14:00.000Z'));
  await listCliConversations('agent');
  await removalsSettle();
  expect(mocks.warn).not.toHaveBeenCalled();
  vi.setSystemTime(new Date('2026-11-04T10:15:00.000Z'));
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toContainEqual(['--delete-cli-conversation-copies', ['session-1']]);
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      event: 'cli_conversation.copy_cleanup',
      stage: 'abandoned',
      sessionId: 'session-1',
      recordedAt: '2026-11-04T10:00:00.000Z',
    })
  );
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('keeps trying, however long it takes, while removing a copy fails', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'));
  hostAnswers({ '--delete-cli-conversation-copies': new Error('ssh: connection reset') });
  await discardCliConversationCopies(location as never, 'session-1');
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      event: 'cli_conversation.copy_cleanup',
      stage: 'failed',
      sessionIds: ['session-1'],
    })
  );
  vi.setSystemTime(new Date('2026-11-04T11:00:00.000Z'));
  hostAnswers({
    '--delete-cli-conversation-copies': { deleted: { 'session-1': 1 } },
    '--fork-cli-conversation': { nativeSessionId: 'copy-2' },
  });
  mocks.runHostRequest.mockClear();
  await expect(
    forkCliConversation(location as never, { id: 'session-2', title: 'Fix' }, 'cli-1', true)
  ).resolves.toBe('copy-2');
  await removalsSettle();
  expect(asked()).toContainEqual(['--delete-cli-conversation-copies', ['session-1']]);
  // Another location's copies are its own.
  const elsewhere = newLocation();
  hostAnswers({ '--delete-cli-conversation-copies': new Error('ssh: connection reset') });
  await discardCliConversationCopies(elsewhere as never, 'session-3');
  hostAnswers({ '--cli-conversations': { ownershipKnown: true, conversations: [] } });
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('asks the host once for every session whose copies it is removing', async () => {
  hostAnswers({
    '--fork-cli-conversation': new Error('Timed out after 120000ms'),
    '--delete-cli-conversation-copies': new Error('ssh: connection reset'),
  });
  for (const id of ['session-1', 'session-2'])
    await expect(
      forkCliConversation(location as never, { id, title: 'Fix' }, 'cli-1', true)
    ).rejects.toThrow('Timed out');
  await removalsSettle();
  hostAnswers({
    '--delete-cli-conversation-copies': { deleted: { 'session-1': 1, 'session-2': 0 } },
    '--cli-conversations': { ownershipKnown: true, conversations: [] },
  });
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([
    ['--cli-conversations', undefined],
    ['--delete-cli-conversation-copies', ['session-1', 'session-2']],
  ]);
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toContainEqual(['--delete-cli-conversation-copies', ['session-2']]);
});

it('removes the copies of more sessions than one request may name in several requests', async () => {
  const ids = sessionIds(MAX_SESSIONS_PER_REQUEST + 1);
  hostRemovesCopies(null);
  await Promise.all(ids.map((id) => discardCliConversationCopies(location as never, id)));
  expect(asked()).toEqual([
    ['--delete-cli-conversation-copies', ids.slice(0, MAX_SESSIONS_PER_REQUEST)],
    ['--delete-cli-conversation-copies', ids.slice(MAX_SESSIONS_PER_REQUEST)],
  ]);
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([['--cli-conversations', undefined]]);
});

it('still asks about the other sessions when one request of a removal fails, and tries again only those it named', async () => {
  const ids = sessionIds(MAX_SESSIONS_PER_REQUEST + 1);
  const firstRequest = ids.slice(0, MAX_SESSIONS_PER_REQUEST);
  hostAnswers({ '--delete-cli-conversation-copies': new Error('ssh: connection reset') });
  await Promise.all(ids.map((id) => discardCliConversationCopies(location as never, id)));
  hostRemovesCopies('session-1');
  mocks.runHostRequest.mockClear();
  mocks.warn.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([
    ['--cli-conversations', undefined],
    ['--delete-cli-conversation-copies', firstRequest],
    ['--delete-cli-conversation-copies', ids.slice(MAX_SESSIONS_PER_REQUEST)],
  ]);
  expect(mocks.warn).toHaveBeenCalledTimes(1);
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ stage: 'failed', sessionIds: firstRequest })
  );
  mocks.runHostRequest.mockClear();
  await listCliConversations('agent');
  await removalsSettle();
  expect(asked()).toEqual([
    ['--cli-conversations', undefined],
    ['--delete-cli-conversation-copies', firstRequest],
  ]);
});

it('does not hold up a list or a copy for the removals it starts', async () => {
  hostAnswers({
    '--fork-cli-conversation': new Error('Timed out after 120000ms'),
    '--delete-cli-conversation-copies': new Error('ssh: connection reset'),
  });
  await expect(
    forkCliConversation(location as never, { id: 'session-1', title: 'Fix' }, 'cli-1', true)
  ).rejects.toThrow('Timed out');
  await removalsSettle();
  hostAnswers({
    '--delete-cli-conversation-copies': new Promise(() => {}),
    '--cli-conversations': { ownershipKnown: true, conversations: [conversation('cli-1')] },
    '--fork-cli-conversation': { nativeSessionId: 'copy-2' },
  });
  await expect(listCliConversations('agent')).resolves.toEqual({
    success: true,
    data: { ownershipKnown: true, conversations: [conversation('cli-1')] },
  });
  await expect(
    forkCliConversation(location as never, { id: 'session-2', title: 'Fix' }, 'cli-1', true)
  ).resolves.toBe('copy-2');
});
