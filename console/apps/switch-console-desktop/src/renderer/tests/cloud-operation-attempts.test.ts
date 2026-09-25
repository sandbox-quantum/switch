import { beforeEach, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  operations: new Map<string, { sessionId: string; action: string }>(),
  sessions: new Set<string>(),
  restarts: 0,
  loseNextResponse: false,
  failNext: false,
}));

const cloudSessionOperation = vi.hoisted(() =>
  vi.fn(async (_agentKey: string, sessionId: string, operationId: string, action: string) => {
    if (server.failNext) {
      server.failNext = false;
      return { state: 'failed', message: 'session limit' };
    }
    if (!server.operations.has(operationId)) {
      server.operations.set(operationId, { sessionId, action });
      if (action === 'start') server.sessions.add(sessionId);
      else server.restarts += 1;
    }
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

const agentKey = 'cloud:server:launch';

beforeEach(() => {
  server.operations.clear();
  server.sessions.clear();
  server.restarts = 0;
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
  expect(a[2]).toBe(a[1]);
  expect(server.sessions.size).toBe(1);
  expect(cloudOperationAttempts.get(key)).toBeUndefined();
});

it('asks for the same restart again after a lost response, so it restarts once', async () => {
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
  expect(server.restarts).toBe(1);
  expect(cloudOperationAttempts.get(key)).toBeUndefined();
});

it('treats a call that never answered as unknown and keeps the attempt', async () => {
  const key = startAttemptKey(agentKey);
  cloudSessionOperation.mockRejectedValueOnce(new Error('IPC channel closed'));
  const first = await cloudOperationAttempts.run(key, agentKey, 'start', null);
  expect(first?.outcome.state).toBe('unknown');
  expect(cloudOperationAttempts.get(key)?.operationId).toBe(first?.sessionId);
});

it('ignores a second ask while the first is in flight', async () => {
  const key = startAttemptKey(agentKey);
  const first = cloudOperationAttempts.run(key, agentKey, 'start', null);
  expect(await cloudOperationAttempts.run(key, agentKey, 'start', null)).toBeNull();
  await first;
  expect(cloudSessionOperation).toHaveBeenCalledTimes(1);
});

it('uses a fresh id after a definite failure', async () => {
  const key = restartAttemptKey(agentKey, 'session');
  server.failNext = true;
  expect((await cloudOperationAttempts.run(key, agentKey, 'restart', 'session'))?.outcome).toEqual({
    state: 'failed',
    message: 'session limit',
  });
  expect(cloudOperationAttempts.get(key)).toBeUndefined();
  await cloudOperationAttempts.run(key, agentKey, 'restart', 'session');
  const [a, b] = cloudSessionOperation.mock.calls;
  expect(b[2]).not.toBe(a[2]);
});
