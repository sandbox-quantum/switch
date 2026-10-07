import { beforeEach, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  sessions: new Set<string>(),
  loseNextResponse: false,
  failNext: false,
}));

const cloudSessionOperation = vi.hoisted(() =>
  vi.fn(async (_agentKey: string, sessionId: string, action: string) => {
    if (server.failNext) {
      server.failNext = false;
      return { state: 'failed', message: 'session limit', code: null };
    }
    if (action === 'start') server.sessions.add(sessionId);
    if (server.loseNextResponse) {
      server.loseNextResponse = false;
      return { state: 'unknown', message: 'The server did not confirm the session.' };
    }
    return { state: 'applied' };
  })
);

vi.mock('@renderer/lib/ipc', () => ({ rpc: { sdkHost: { cloudSessionOperation } } }));

const { cloudOperationAttempts, restartAttemptKey, startAttemptKey } =
  await import('@renderer/features/cloud-agents/cloud-operation-attempts');

const agentKey = 'cloud:server:agent=agent';

beforeEach(() => {
  server.sessions.clear();
  server.loseNextResponse = false;
  server.failNext = false;
  cloudSessionOperation.mockClear();
  cloudOperationAttempts.settle(startAttemptKey(agentKey));
  cloudOperationAttempts.settle(restartAttemptKey(agentKey, 'session'));
});

it('asks for the same session again after a lost start response, so one session results', async () => {
  const key = startAttemptKey(agentKey);
  server.loseNextResponse = true;
  const first = await cloudOperationAttempts.run(key, agentKey, 'start', null);
  expect(first?.outcome.state).toBe('unknown');
  expect(cloudOperationAttempts.get(key)).toMatchObject({
    status: 'unknown',
    sessionId: first?.sessionId,
  });
  const second = await cloudOperationAttempts.run(key, agentKey, 'start', null);
  expect(second).toEqual({ sessionId: first?.sessionId, outcome: { state: 'applied' } });
  const [a, b] = cloudSessionOperation.mock.calls;
  expect(b).toEqual(a);
  expect(server.sessions.size).toBe(1);
  expect(cloudOperationAttempts.get(key)).toBeUndefined();
});

it('asks to restart the same session again after a lost response', async () => {
  const key = restartAttemptKey(agentKey, 'session');
  server.loseNextResponse = true;
  expect(
    (await cloudOperationAttempts.run(key, agentKey, 'restart', 'session'))?.outcome.state
  ).toBe('unknown');
  expect(
    (await cloudOperationAttempts.run(key, agentKey, 'restart', 'session'))?.outcome.state
  ).toBe('applied');
  const [a, b] = cloudSessionOperation.mock.calls;
  expect(b).toEqual(a);
  expect(a).toEqual([agentKey, 'session', 'restart']);
  expect(cloudOperationAttempts.get(key)).toBeUndefined();
});

it('treats a call that never answered as unknown and keeps the attempt', async () => {
  const key = startAttemptKey(agentKey);
  cloudSessionOperation.mockRejectedValueOnce(new Error('IPC channel closed'));
  const first = await cloudOperationAttempts.run(key, agentKey, 'start', null);
  expect(first?.outcome.state).toBe('unknown');
  expect(cloudOperationAttempts.get(key)?.sessionId).toBe(first?.sessionId);
});

it('ignores a second ask while the first is in flight', async () => {
  const key = startAttemptKey(agentKey);
  const first = cloudOperationAttempts.run(key, agentKey, 'start', null);
  expect(await cloudOperationAttempts.run(key, agentKey, 'start', null)).toBeNull();
  await first;
  expect(cloudSessionOperation).toHaveBeenCalledTimes(1);
});

it('starts a fresh session after a definite failure', async () => {
  const key = startAttemptKey(agentKey);
  server.failNext = true;
  expect((await cloudOperationAttempts.run(key, agentKey, 'start', null))?.outcome).toEqual({
    state: 'failed',
    message: 'session limit',
    code: null,
  });
  expect(cloudOperationAttempts.get(key)).toBeUndefined();
  await cloudOperationAttempts.run(key, agentKey, 'start', null);
  const [a, b] = cloudSessionOperation.mock.calls;
  expect(b[1]).not.toBe(a[1]);
});
