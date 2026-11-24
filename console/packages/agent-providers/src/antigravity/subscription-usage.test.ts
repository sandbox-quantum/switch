import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readiness } from '../readiness';
import { readAntigravitySubscriptionUsage } from './subscription-usage';

const cli = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: cli.stat }));
vi.mock('../provider-process', () => ({ spawnProvider: cli.spawn, stopProvider: cli.stop }));

const checkSignIn = vi.fn();
const input = (
  binaryPath: string,
  env: Record<string, string> = {},
  signal = new AbortController().signal
) => ({ binaryPath, cwd: '.', env, signal });

const bucket = (window: string, remaining_fraction: number, reset_time: string) => ({
  name: window,
  window,
  remaining_fraction,
  reset_time,
});
const report = (num_turns = 0, total_tokens = 0) =>
  JSON.stringify({
    status: 'SUCCESS',
    num_turns,
    usage: { total_tokens },
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'First model pool',
            buckets: [
              bucket('5h', 1, '1970-01-01T00:00:00Z'),
              bucket('weekly', 0.55, '2030-02-03T09:00:00Z'),
            ],
          },
          {
            name: 'Second model pool',
            buckets: [
              bucket('weekly', 0.25, '2030-02-05T08:00:00Z'),
              { ...bucket('5h', 0, '2030-02-03T08:30:00Z'), disabled: true },
            ],
          },
        ],
      },
    },
  });

function childOutput(stdout: string, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => {
    child.stdout.write(stdout);
    child.emit('close', code);
  });
  return child;
}

beforeEach(() => {
  vi.resetAllMocks();
  cli.stat.mockResolvedValue({ ino: 1, size: 2, mtimeMs: 3, ctimeMs: 4 });
  cli.spawn.mockImplementation((_command, args: string[]) =>
    childOutput(args[0] === '--version' ? 'agy 1.5.13' : report())
  );
  checkSignIn.mockResolvedValue(readiness('authenticated', 'Signed in'));
});
afterEach(() => vi.useRealTimers());

it('checks auth before a zero-turn probe and summarizes the most constrained windows', async () => {
  const result = await readAntigravitySubscriptionUsage(input('/local/current/agy'), checkSignIn);
  expect(result).toMatchObject({
    status: 'ok',
    windows: [
      { label: '5h', usedPercent: 0, resetsAt: null },
      { label: '7d', usedPercent: 75, resetsAt: Date.parse('2030-02-05T08:00:00Z') },
    ],
    buckets: [
      { group: 'First model pool' },
      { group: 'First model pool' },
      { group: 'Second model pool' },
    ],
  });
  expect(cli.spawn.mock.calls[1]?.[1]).toEqual([
    '-p',
    '/usage',
    '--output-format',
    'json',
    '--print-timeout',
    '20s',
  ]);
  expect(checkSignIn.mock.invocationCallOrder[0]).toBeLessThan(
    cli.spawn.mock.invocationCallOrder[1]!
  );
  for (const [, , options] of cli.spawn.mock.calls)
    expect(options.env).toMatchObject({ BROWSER: 'false', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
});

it.each(['/local/antigravity-acp', 'C:/tools/antigravity.cmd'])(
  'refuses launcher %s without starting it',
  async (path) => {
    await expect(readAntigravitySubscriptionUsage(input(path), checkSignIn)).resolves.toMatchObject(
      { status: 'unavailable' }
    );
    expect(cli.spawn).not.toHaveBeenCalled();
  }
);

it('refuses an old CLI and checks again when the executable changes at the same path', async () => {
  const path = '/local/replaced/agy';
  await readAntigravitySubscriptionUsage(input(path), checkSignIn);
  cli.stat.mockResolvedValue({ ino: 5, size: 2, mtimeMs: 6, ctimeMs: 7 });
  cli.spawn.mockImplementationOnce(() => childOutput('1.5.12'));
  await expect(readAntigravitySubscriptionUsage(input(path), checkSignIn)).resolves.toMatchObject({
    status: 'unavailable',
  });
  expect(cli.spawn.mock.calls.map(([, args]) => args[0])).toEqual(['--version', '-p', '--version']);
  expect(checkSignIn).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'skips /usage when the consumer account is unsigned (API key present: %s)',
  async (apiKey) => {
    checkSignIn.mockResolvedValueOnce(readiness('unauthenticated', 'Sign in'));
    const result = await readAntigravitySubscriptionUsage(
      input(`/local/unsigned-${apiKey}/agy`, apiKey ? { GEMINI_API_KEY: 'test-key' } : {}),
      checkSignIn
    );
    expect(result.status).toBe(apiKey ? 'unavailable' : 'unauthenticated');
    expect(checkSignIn.mock.calls[0]?.[0].env).not.toHaveProperty('GEMINI_API_KEY');
    expect(cli.spawn).toHaveBeenCalledOnce();
  }
);

it.each([
  [1, 0],
  [0, 2],
])('latches the binary after observing %s turns and %s tokens', async (turns, tokens) => {
  const path = `/local/billable-${turns}/agy`;
  cli.spawn.mockImplementation((_command, args: string[]) =>
    childOutput(args[0] === '--version' ? '1.5.13' : report(turns, tokens))
  );
  await expect(readAntigravitySubscriptionUsage(input(path), checkSignIn)).resolves.toMatchObject({
    status: 'unavailable',
  });
  await expect(readAntigravitySubscriptionUsage(input(path), checkSignIn)).resolves.toMatchObject({
    status: 'unavailable',
  });
  expect(cli.spawn).toHaveBeenCalledTimes(2);
});

it.each([
  { num_turns: 1 },
  { usage: { total_tokens: 4 } },
  { conversation_id: 'started-conversation' },
  { command: { name: 'other' } },
])('latches unexpected activity on a nonzero process exit (%j)', async (activity) => {
  const path = `/local/nonzero-${Object.keys(activity)[0]}/agy`;
  cli.spawn.mockImplementation((_command, args: string[]) =>
    args[0] === '--version' ? childOutput('1.5.13') : childOutput(JSON.stringify(activity), 1)
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(readAntigravitySubscriptionUsage(input(path), checkSignIn)).resolves.toMatchObject(
      {
        status: 'unavailable',
      }
    );
  expect(cli.spawn).toHaveBeenCalledTimes(2);
  expect(checkSignIn).toHaveBeenCalledOnce();
});

it.each(['abort', 'timeout'])('stops on %s when the child never emits close', async (reason) => {
  vi.useFakeTimers();
  const running = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  cli.spawn.mockImplementation((_command, args: string[]) => {
    if (args[0] === '--version') return childOutput('1.5.13');
    return running;
  });
  const abort = new AbortController();
  const result = readAntigravitySubscriptionUsage(
    input(`/local/${reason}/agy`, {}, abort.signal),
    checkSignIn
  );
  const settled =
    reason === 'abort'
      ? expect(result).rejects.toMatchObject({ name: 'AbortError' })
      : expect(result).resolves.toMatchObject({ status: 'error' });
  await vi.advanceTimersByTimeAsync(0);
  expect(cli.spawn).toHaveBeenCalledTimes(2);
  if (reason === 'abort') abort.abort();
  else await vi.advanceTimersByTimeAsync(25_000);
  await settled;
  expect(cli.stop).toHaveBeenCalledWith(running, 'SIGKILL');
  expect(running.stdout.destroyed).toBe(true);
  expect(running.stderr.destroyed).toBe(true);
});
