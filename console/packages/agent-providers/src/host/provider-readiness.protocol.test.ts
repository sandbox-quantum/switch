import { beforeEach, expect, it, vi } from 'vitest';
import type * as Protocol from '../transport/stdio-json-rpc';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { checkProviderReadiness } from './provider-readiness';
const mock = vi.hoisted(() => ({ request: vi.fn(), dispose: vi.fn(), notify: vi.fn() }));
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
  mock.dispose.mockResolvedValue(undefined);
});
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));
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
// The probe used to answer "are you signed in?" by calling `authenticate` —
// which does not test the sign-in, it performs it, opening a browser. It then
// reported success whether or not anything had happened. Asking a question must
// not be the thing that changes the answer.
it('answers Antigravity sign-in from the handshake, without signing in', async () => {
  mock.request.mockResolvedValueOnce({ authMethods: [] });
  const result = await checkProviderReadiness({ ...input, provider: 'antigravity' });
  expect(result.status).toBe('authenticated');
  expect(mock.request.mock.calls.map((call) => call[0])).toEqual(['initialize']);
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('never calls authenticate, whatever the agent reports', async () => {
  mock.request.mockResolvedValueOnce({ authMethods: [{ id: 'oauth-personal' }] });
  await checkProviderReadiness({ ...input, provider: 'antigravity' });
  expect(mock.request.mock.calls.map((call) => call[0])).not.toContain('authenticate');
});
it('reports an outstanding Antigravity sign-in as unauthenticated', async () => {
  mock.request.mockResolvedValueOnce({ authMethods: [{ id: 'oauth-personal' }] });
  const result = await checkProviderReadiness({ ...input, provider: 'antigravity' });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toContain('antigravity-acp --login');
  expect(mock.dispose).toHaveBeenCalledOnce();
});
// An agent that says nothing about auth is not an agent asking to be signed in.
it('treats a handshake with no authMethods as nothing outstanding', async () => {
  mock.request.mockResolvedValueOnce({});
  expect((await checkProviderReadiness({ ...input, provider: 'antigravity' })).status).toBe(
    'authenticated'
  );
});
it('reports Antigravity handshake failures', async () => {
  mock.request.mockRejectedValueOnce(new Error('Sign in required'));
  expect((await checkProviderReadiness({ ...input, provider: 'antigravity' })).status).toBe(
    'unauthenticated'
  );
});
