import type * as ChildProcess from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import type * as Protocol from '../transport/stdio-json-rpc';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { checkProviderReadiness } from './provider-readiness';
const mock = vi.hoisted(() => ({ request: vi.fn(), dispose: vi.fn(), notify: vi.fn() }));
let models = '';
// The Antigravity probe shells out rather than speaking a protocol, so the
// promisified `execFile` is what has to be stood in for.
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  const { promisify } = await import('node:util');
  const execFile = (() => {
    throw new Error('Only the promisified execFile is used.');
  }) as unknown as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: async () => ({ stdout: models, stderr: '' }),
  });
  return { ...actual, execFile };
});
vi.mock('../transport/stdio-json-rpc', async (original) => ({
  ...(await original<typeof Protocol>()),
  StdioJsonRpcClient: class {
    request = mock.request;
    dispose = mock.dispose;
    notify = mock.notify;
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  models = 'Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n';
  mock.dispose.mockResolvedValue(undefined);
});
const input = { binaryPath: 'provider', cwd: '/tmp', env: {} };
it('blocks missing Codex credentials only when the backend requires authentication', async () => {
  mock.request
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ account: null, requiresOpenaiAuth: true });
  expect((await checkProviderReadiness({ ...input, provider: 'codex' })).status).toBe(
    'unauthenticated'
  );
  expect(mock.request).toHaveBeenLastCalledWith('account/read', { refreshToken: false });
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('allows a Codex backend that does not require OpenAI login', async () => {
  mock.request
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ account: null, requiresOpenaiAuth: false });
  expect((await checkProviderReadiness({ ...input, provider: 'codex' })).status).toBe('unknown');
});
it('recognizes a Codex sign-in rejection and cleans up', async () => {
  mock.request
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new JsonRpcError(-32000, 'Please log in to continue.'));
  expect((await checkProviderReadiness({ ...input, provider: 'codex' })).status).toBe(
    'unauthenticated'
  );
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('does not classify a transport failure as missing credentials', async () => {
  mock.request.mockRejectedValue(new Error('Connection closed'));
  expect((await checkProviderReadiness({ ...input, provider: 'codex' })).status).toBe('unknown');
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('reads Antigravity models without starting a conversation', async () => {
  const readiness = await checkProviderReadiness({ ...input, provider: 'antigravity' });
  expect(readiness.status).toBe('authenticated');
  expect(readiness.models).toEqual([{ id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' }]);
  expect(mock.request).not.toHaveBeenCalled();
});
it('reports an Antigravity sign-in prompt as unauthenticated', async () => {
  models = 'Authentication required. Please visit the URL to log in:\nhttps://example.invalid/auth';
  const readiness = await checkProviderReadiness({ ...input, provider: 'antigravity' });
  expect(readiness.status).toBe('unauthenticated');
  expect(readiness.message).toContain('agy');
});
it('leaves an Antigravity probe that says nothing useful inconclusive', async () => {
  models = '';
  expect((await checkProviderReadiness({ ...input, provider: 'antigravity' })).status).toBe(
    'unknown'
  );
});
