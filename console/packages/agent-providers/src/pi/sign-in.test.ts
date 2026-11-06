import { beforeEach, expect, it, vi } from 'vitest';
import { FakePi } from './fake-pi';

const processes: FakePi[] = [];
const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
/** The models the fake Pi lists: none when nothing is signed in. */
let models: Array<{ id: string; provider: string }> = [];
/** Whether the fake Pi dies instead of answering. */
let crashes = false;
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ command, args, env: options.env });
    const pi = new FakePi();
    if (crashes) queueMicrotask(() => pi.crash());
    else pi.answer('get_available_models', () => ({ models }));
    processes.push(pi);
    return pi;
  },
}));
const { checkPiSignIn, PI_SIGNED_OUT } = await import('./sign-in');

const input = {
  binaryPath: 'pi',
  cwd: '/work',
  env: { HOME: '/home/u', PI_CODING_AGENT_DIR: '/pi' },
};

beforeEach(() => {
  processes.length = 0;
  spawned.length = 0;
  models = [];
  crashes = false;
});

it('reports a Pi with a model to use as signed in', async () => {
  models = [{ id: 'claude-sonnet', provider: 'anthropic' }];
  expect(await checkPiSignIn(input)).toEqual({
    status: 'authenticated',
    message: 'Signed in.',
    models: [],
  });
});

it('reports a Pi with no model as signed out, saying how to sign in', async () => {
  const result = await checkPiSignIn(input);
  expect(result).toEqual({ status: 'unauthenticated', message: PI_SIGNED_OUT, models: [] });
  expect(PI_SIGNED_OUT).toBe(
    'Sign in on the execution machine with pi. Choose a provider with /login, or set a provider API key such as ANTHROPIC_API_KEY.'
  );
});

it('only lists models: nothing is saved, no server is connected, and no login starts', async () => {
  await checkPiSignIn(input);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.args).toEqual(['--mode', 'rpc', '--no-session', '--no-mcp']);
  expect(spawned[0]!.env).toEqual({ ...input.env, PI_SKIP_VERSION_CHECK: '1' });
  expect(processes[0]!.received.map((command) => command.type)).toEqual(['get_available_models']);
});

it('stops the Pi it started', async () => {
  await checkPiSignIn(input);
  expect(processes[0]!.killed).toContain('SIGTERM');
});

it('throws when Pi dies before it answers, which the caller reports as unknown rather than signed out', async () => {
  crashes = true;
  await expect(checkPiSignIn(input)).rejects.toThrow('provider process exited');
});
