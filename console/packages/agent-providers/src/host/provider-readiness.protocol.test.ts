import { beforeEach, expect, it, vi } from 'vitest';
import type * as Protocol from '../transport/stdio-json-rpc';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { checkProviderReadiness } from './provider-readiness';
const mock = vi.hoisted(() => ({
  request: vi.fn(),
  dispose: vi.fn(),
  notify: vi.fn(),
  token: null as string | null,
}));
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
  mock.token = null;
});
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => {
    if (mock.token === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return mock.token;
  }),
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
const agy = { ...input, binaryPath: 'agy', provider: 'antigravity' };
it('asks agy for its sessions, which it refuses when signed out, without signing in', async () => {
  mock.request
    .mockResolvedValueOnce({ authMethods: [{ id: 'oauth-personal' }] })
    .mockResolvedValueOnce({ sessions: [] });
  const result = await checkProviderReadiness(agy);
  expect(result.status).toBe('authenticated');
  expect(mock.request.mock.calls.map((call) => call[0])).toEqual(['initialize', 'session/list']);
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('reports a signed-out agy as unauthenticated, pointing at agy acp --login', async () => {
  mock.request
    .mockResolvedValueOnce({ authMethods: [{ id: 'oauth-personal' }] })
    .mockRejectedValueOnce(new JsonRpcError(-32000, 'Authentication required'));
  const result = await checkProviderReadiness(agy);
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toContain('agy acp --login');
  expect(mock.request.mock.calls.map((call) => call[0])).not.toContain('authenticate');
  expect(mock.dispose).toHaveBeenCalledOnce();
});
// agy keeps the method it is sent: authenticating with the key, even once,
// would move a user signed in with Google onto the key for good.
it('checks agy without choosing the Gemini API key the environment carries', async () => {
  mock.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ sessions: [] });
  const result = await checkProviderReadiness({ ...agy, env: { GEMINI_API_KEY: 'placeholder' } });
  expect(result.status).toBe('authenticated');
  expect(mock.request.mock.calls).toEqual([
    ['initialize', expect.anything()],
    ['session/list', {}],
  ]);
});
it('counts on the Gemini API key for an agy not signed in itself, saying it is unchecked', async () => {
  mock.request
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new JsonRpcError(-32000, 'Authentication required'));
  const result = await checkProviderReadiness({ ...agy, env: { GEMINI_API_KEY: 'placeholder' } });
  expect(result).toMatchObject({ status: 'authenticated' });
  expect(result.message).toContain('checked when one starts');
  expect(mock.request.mock.calls.map((call) => call[0])).toEqual(['initialize', 'session/list']);
});
// A legacy `antigravity-acp` install keeps its own profile and is checked as before.
const legacy = { ...input, binaryPath: '/home/u/.local/bin/antigravity-acp' };
it('answers legacy Antigravity ACP sign-in from the handshake, without signing in', async () => {
  mock.request.mockResolvedValueOnce({ authMethods: [] });
  const result = await checkProviderReadiness({ ...legacy, provider: 'antigravity' });
  expect(result.status).toBe('authenticated');
  expect(mock.request.mock.calls.map((call) => call[0])).toEqual(['initialize']);
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('never calls authenticate on a legacy install, whatever it reports', async () => {
  mock.request.mockResolvedValueOnce({ authMethods: [{ id: 'oauth-personal' }] });
  await checkProviderReadiness({ ...legacy, provider: 'antigravity' });
  expect(mock.request.mock.calls.map((call) => call[0])).not.toContain('authenticate');
});
it('reports an outstanding legacy sign-in as unauthenticated', async () => {
  mock.request.mockResolvedValueOnce({ authMethods: [{ id: 'oauth-personal' }] });
  const result = await checkProviderReadiness({ ...legacy, provider: 'antigravity' });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toContain('antigravity-acp --login');
  // Console's sign-in hint and button follow the executable checked.
  expect(result.loginCommand).toBe('antigravity-acp --login');
  expect(mock.dispose).toHaveBeenCalledOnce();
});
it('names no login command of its own for agy, the provider’s usual one', async () => {
  mock.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ sessions: [] });
  expect(await checkProviderReadiness(agy)).not.toHaveProperty('loginCommand');
});
// Antigravity ACP 1.3 lists every sign-in method in its handshake, signed in or
// not: the token --login wrote is what says.
it('counts the token --login wrote as signed in when the handshake lists methods', async () => {
  mock.request.mockResolvedValueOnce({ authMethods: [{ id: 'oauth-personal' }] });
  mock.token = '{"access_token":"a","refresh_token":"r"}';
  const result = await checkProviderReadiness({
    ...legacy,
    provider: 'antigravity',
    env: { GEMINI_HOME: '/profile' },
  });
  expect(result.status).toBe('authenticated');
  expect(mock.request.mock.calls.map((call) => call[0])).toEqual(['initialize']);
});
// An agent that says nothing about auth is not an agent asking to be signed in.
it('treats a legacy handshake with no authMethods as nothing outstanding', async () => {
  mock.request.mockResolvedValueOnce({});
  expect((await checkProviderReadiness({ ...legacy, provider: 'antigravity' })).status).toBe(
    'authenticated'
  );
});
it('reports Antigravity handshake failures', async () => {
  mock.request.mockRejectedValueOnce(new Error('Sign in required'));
  expect((await checkProviderReadiness({ ...input, provider: 'antigravity' })).status).toBe(
    'unauthenticated'
  );
});
