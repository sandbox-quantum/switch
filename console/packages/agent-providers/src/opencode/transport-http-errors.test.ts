import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError, ProviderUnavailableError } from '../adapter';
import { createHttpTransport } from './transport';

const stop = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./server', () => ({
  startOpencodeServer: async () => ({
    url: 'http://127.0.0.1:1234',
    authorization: '',
    process: new EventEmitter(),
  }),
  stopOpencodeServer: stop,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const input = {
  sessionId: 'session',
  cwd: '/tmp/workspace',
  env: {},
  config: { $schema: 'https://opencode.ai/config.json' as const, permission: {}, mcp: {} },
  permission: [],
};

it.each([false, true])(
  'maps a real SDK 500 response to a transient startup failure (resume=%s)',
  async (resume) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) =>
        new URL(request.url).pathname === '/provider'
          ? Response.json({ connected: ['backend'], all: [] })
          : Response.json({ message: 'database is locked' }, { status: 500 })
      )
    );
    await expect(
      createHttpTransport({ binaryPath: 'opencode', startupTimeoutMs: 1000, skills: [] }).open({
        ...input,
        ...(resume ? { resumeNativeSessionId: 'native' } : {}),
      })
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(stop).toHaveBeenCalledOnce();
  }
);

it('offers conversation recovery only for a real SDK 404 on resume', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) =>
      new URL(request.url).pathname === '/provider'
        ? Response.json({ connected: ['backend'], all: [] })
        : Response.json({ message: 'Not found' }, { status: 404 })
    )
  );
  await expect(
    createHttpTransport({ binaryPath: 'opencode', startupTimeoutMs: 1000, skills: [] }).open({
      ...input,
      resumeNativeSessionId: 'native',
    })
  ).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
  expect(stop).toHaveBeenCalledOnce();
});
