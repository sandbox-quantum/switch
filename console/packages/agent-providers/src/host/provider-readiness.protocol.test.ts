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
it('recognizes Gemini missing-key rejection and cleans up', async () => {
  mock.request
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(
      new JsonRpcError(-32000, 'Gemini API key is missing or not configured.')
    );
  expect((await checkProviderReadiness({ ...input, provider: 'gemini' })).status).toBe(
    'unauthenticated'
  );
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('does not classify a transport failure as missing credentials', async () => {
  mock.request.mockRejectedValue(new Error('Connection closed'));
  expect((await checkProviderReadiness({ ...input, provider: 'gemini' })).status).toBe('unknown');
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('reads Gemini models without sending a prompt', async () => {
  mock.request.mockResolvedValueOnce({}).mockResolvedValueOnce({
    models: { availableModels: [{ modelId: 'example-model', name: 'Example' }] },
  });
  expect((await checkProviderReadiness({ ...input, provider: 'gemini' })).models).toEqual([
    { id: 'example-model', name: 'Example' },
  ]);
  expect(mock.request.mock.calls.map((call) => call[0])).toEqual(['initialize', 'session/new']);
});
