import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError } from '../adapter';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  providers: vi.fn(),
  create: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('./server', () => ({ startOpencodeServer: mocks.start, stopOpencodeServer: mocks.stop }));
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: () => ({
    event: { subscribe: mocks.subscribe },
    provider: { list: mocks.providers },
    session: { create: mocks.create },
  }),
}));
const { createHttpTransport } = await import('./transport');
const options = { binaryPath: 'opencode', startupTimeoutMs: 15000, skills: [] };
const input = {
  sessionId: 'session',
  cwd: '/tmp/workspace',
  env: {},
  config: { $schema: 'https://opencode.ai/config.json' as const, permission: {}, mcp: {} },
  permission: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.start.mockResolvedValue({
    url: 'http://127.0.0.1:1234',
    authorization: '',
    process: new EventEmitter(),
  });
  mocks.subscribe.mockResolvedValue({ stream: (async function* () {})() });
  mocks.providers.mockResolvedValue({ data: { connected: ['backend'], all: [] } });
  mocks.create.mockResolvedValue({ data: { id: 'native' } });
});
afterEach(() => vi.restoreAllMocks());
it('checks backend authentication on the session server without a second process', async () => {
  const session = await createHttpTransport(options).open(input);
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.providers).toHaveBeenCalledOnce();
  expect(mocks.providers.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.create.mock.invocationCallOrder[0]
  );
  await session.dispose();
});
it('cleans up when the backend authentication check fails', async () => {
  mocks.providers.mockRejectedValue(new Error('Authentication unavailable'));
  await expect(createHttpTransport(options).open(input)).rejects.toThrow(
    'Authentication unavailable'
  );
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it('discloses an inconclusive backend check for local models', async () => {
  mocks.providers.mockResolvedValue({ data: { connected: [], all: [] } });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const session = await createHttpTransport(options).open(input);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('No connected OpenCode backends'));
  await session.dispose();
});

it('preserves the startup error when cleanup also fails', async () => {
  const original = new Error('database is locked', { cause: { status: 500 } });
  const cleanup = new Error('process did not exit');
  mocks.providers.mockRejectedValue(original);
  mocks.stop.mockRejectedValue(cleanup);
  await expect(createHttpTransport(options).open(input)).rejects.toMatchObject({
    message: 'OpenCode startup cleanup failed. Stop and start the agent before retrying.',
    cause: { errors: [original, cleanup] },
  });
});

it('blocks reset and explains recovery when conversation lookup and cleanup both fail', async () => {
  const original = new ProviderConversationUnavailableError(
    'opencode',
    'session',
    'Conversation missing'
  );
  const cleanup = new Error('process did not exit');
  mocks.providers.mockRejectedValue(original);
  mocks.stop.mockRejectedValue(cleanup);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(createHttpTransport(options).open(input)).rejects.toMatchObject({
    message: expect.stringContaining('conversation is unavailable and provider cleanup failed'),
    cause: { errors: [original, cleanup] },
  });
  expect(logged).toHaveBeenCalledWith('OpenCode startup and cleanup failed:', original, cleanup);
});
