import { beforeEach, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => ({ result: { stdout: '' } as unknown }));
vi.mock('../provider-process', () => ({
  execProvider: vi.fn(async () => {
    if (run.result instanceof Error) throw run.result;
    return run.result;
  }),
}));
const { checkPiSignIn, parsePiModelList } = await import('./sign-in');
const { execProvider } = await import('../provider-process');

const TABLE = `provider  model                         context  max-out  thinking  images
groq      llama-3.3-70b-versatile       131.1K   32.8K    no        no
groq      openai/gpt-oss-120b           131.1K   65.5K    yes       no
anthropic claude-sonnet-5              1M       128K     yes       yes
`;
const input = { binaryPath: 'pi', cwd: '/work', env: { PATH: '/bin' } };

beforeEach(() => {
  vi.mocked(execProvider).mockClear();
});

it('reads the models `pi --list-models` prints', () => {
  expect(parsePiModelList(TABLE)).toEqual([
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'anthropic', model: 'claude-sonnet-5' },
  ]);
  expect(parsePiModelList('No models available. Use /login')).toEqual([]);
});

it('is signed in when Pi lists a model, and offers those models', async () => {
  run.result = { stdout: TABLE, stderr: '' };
  await expect(checkPiSignIn(input)).resolves.toEqual({
    status: 'authenticated',
    message: 'Signed in to groq, anthropic.',
    models: [
      { id: 'groq/llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile (groq)' },
      { id: 'groq/openai/gpt-oss-120b', name: 'openai/gpt-oss-120b (groq)' },
      { id: 'anthropic/claude-sonnet-5', name: 'claude-sonnet-5 (anthropic)' },
    ],
  });
  expect(vi.mocked(execProvider).mock.calls[0]?.slice(0, 2)).toEqual([
    'pi',
    ['--list-models', '--offline'],
  ]);
});

it('is signed out when Pi has no model with a credential', async () => {
  run.result = {
    stdout: 'No models available. Use /login to log into a provider via OAuth or API key.',
    stderr: '',
  };
  await expect(checkPiSignIn(input)).resolves.toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with pi, then /login.',
  });
});

it('says it cannot tell from output it does not recognise, and lets a failed run throw', async () => {
  run.result = { stdout: 'something else', stderr: '' };
  await expect(checkPiSignIn(input)).resolves.toMatchObject({ status: 'unknown' });
  run.result = new Error('spawn pi ENOENT');
  await expect(checkPiSignIn(input)).rejects.toThrow('ENOENT');
});
