import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Transport from '../transport/stdio-json-rpc';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { readCodexSubscriptionUsage } from './subscription-usage';

const cli = vi.hoisted(() => ({ request: vi.fn(), notify: vi.fn(), dispose: vi.fn() }));

vi.mock('../transport/stdio-json-rpc', async (original) => ({
  ...(await original<typeof Transport>()),
  StdioJsonRpcClient: class {
    request = cli.request;
    notify = cli.notify;
    dispose = cli.dispose;
  },
}));

const account = {
  type: 'chatgpt',
  accountId: 'example-workspace-account',
  email: 'example@example.test',
};
const signal = () => new AbortController().signal;
const read = (abort = signal()) =>
  readCodexSubscriptionUsage({ binaryPath: 'codex', cwd: '.', env: {}, signal: abort });

beforeEach(() => {
  vi.resetAllMocks();
  cli.dispose.mockResolvedValue(undefined);
  cli.request.mockResolvedValueOnce({});
  cli.request.mockResolvedValueOnce({ account, requiresOpenaiAuth: true });
});

afterEach(() => vi.useRealTimers());

it('reads subscription windows, credits and only a hashed account identity', async () => {
  cli.request.mockResolvedValueOnce({
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_895_000_000 },
      secondary: { usedPercent: 119, windowDurationMins: 10_080, resetsAt: 1_895_999_000_000 },
      credits: { hasCredits: true, unlimited: false, balance: '14.25' },
      secret: 'do-not-return',
    },
  });
  const result = await read();
  expect(cli.request.mock.calls.map(([method]) => method)).toEqual([
    'initialize',
    'account/read',
    'account/rateLimits/read',
  ]);
  expect(cli.request).toHaveBeenNthCalledWith(2, 'account/read', { refreshToken: false });
  expect(cli.notify).toHaveBeenCalledWith('initialized', null);
  expect(cli.dispose).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    status: 'ok',
    planLabel: 'Plus',
    accountFingerprint: createHash('sha256').update(account.accountId).digest('hex').slice(0, 16),
    windows: [
      { label: '5h', usedPercent: 12, resetsAt: 1_895_000_000_000 },
      { label: '7d', usedPercent: 100, resetsAt: 1_895_999_000_000 },
    ],
    extraUsage: { unit: 'credits', balance: 14.25 },
  });
  expect(JSON.stringify(result)).not.toMatch(/example|do-not-return/);
});

it('uses the duration for a weekly-only primary window', async () => {
  cli.request.mockResolvedValueOnce({
    rateLimits: { planType: 'prolite', primary: { usedPercent: 30, windowDurationMins: 10_080 } },
  });
  await expect(read()).resolves.toMatchObject({
    planLabel: 'Pro Lite',
    windows: [{ label: '7d', resetsAt: null }],
  });
});

it('reports an individual monthly spend limit when there are no rate windows', async () => {
  cli.request.mockResolvedValueOnce({
    rateLimits: { individualLimit: { remainingPercent: 60, resetsAt: 1_895_000_000 } },
  });
  await expect(read()).resolves.toMatchObject({
    windows: [{ label: 'Monthly spend limit', usedPercent: 40, resetsAt: 1_895_000_000_000 }],
  });
});

it('uses the workspace account ID from the rate limit response for the same email', async () => {
  const emailOnly = {
    account: { type: 'chatgpt', email: 'same@example.test' },
    requiresOpenaiAuth: true,
  };
  cli.request
    .mockReset()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce(emailOnly)
    .mockResolvedValueOnce({ accountId: 'workspace-first', rateLimits: {} })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce(emailOnly)
    .mockResolvedValueOnce({ accountId: 'workspace-second', rateLimits: {} })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce(emailOnly)
    .mockRejectedValueOnce(new JsonRpcError(-32603, 'Temporarily unavailable'));

  const first = await read();
  const second = await read();
  expect(first.accountFingerprint).toBe(
    createHash('sha256').update('workspace-first').digest('hex').slice(0, 16)
  );
  expect(second.accountFingerprint).toBe(
    createHash('sha256').update('workspace-second').digest('hex').slice(0, 16)
  );
  await expect(read()).resolves.toMatchObject({ status: 'error', accountFingerprint: null });
});

it.each([
  [{ type: 'apiKey' }, true, 'unavailable'],
  [null, true, 'unauthenticated'],
  [null, false, 'unavailable'],
] as const)(
  'avoids reading rate limits for %j (requires auth: %s)',
  async (account, requiresOpenaiAuth, status) => {
    cli.request
      .mockReset()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ account, requiresOpenaiAuth });
    await expect(read()).resolves.toMatchObject({ status, windows: [] });
    expect(cli.request).toHaveBeenCalledTimes(2);
  }
);

it('reports auth and transport throttling without disclosing the RPC payload', async () => {
  cli.request.mockRejectedValueOnce(
    new JsonRpcError(-32603, 'HTTP 401 Unauthorized, example private detail')
  );
  await expect(read()).resolves.toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in to Codex to read subscription usage.',
  });
  cli.request
    .mockReset()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ account, requiresOpenaiAuth: true });
  cli.request.mockRejectedValueOnce(new JsonRpcError(429, 'example private detail'));
  await expect(read()).resolves.toMatchObject({
    status: 'error',
    retryAt: expect.any(Number),
    message: 'Codex is rate limiting usage requests.',
  });
});

it('stops the app server on timeout or abort', async () => {
  vi.useFakeTimers();
  const waitForDispose = () =>
    new Promise<never>((_resolve, reject) => {
      cli.dispose.mockImplementationOnce(async () => reject(Error('closed')));
    });
  cli.request.mockImplementationOnce(waitForDispose);
  const result = read();
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(result).resolves.toMatchObject({ status: 'error' });
  expect(cli.dispose).toHaveBeenCalledOnce();

  cli.request
    .mockReset()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ account, requiresOpenaiAuth: true });
  cli.request.mockImplementationOnce(waitForDispose);
  const abort = new AbortController();
  const cancelled = expect(read(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await cancelled;
  expect(cli.dispose).toHaveBeenCalledTimes(2);
});
