import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { verifyModelTurn } from './verify-credential';

const input: ProviderSessionStartInput = {
  sessionId: 'check',
  cwd: '/tmp/check',
  runtimeMode: 'approval-required',
  env: {},
  mcpServers: {},
};

function adapter(reply: string | null, outcome = 'completed') {
  let listener: (event: ProviderRuntimeEvent) => void;
  const unsubscribe = vi.fn();
  const stopAll = vi.fn().mockResolvedValue(undefined);
  const value = {
    subscribe: vi.fn((callback) => {
      listener = callback;
      return unsubscribe;
    }),
    startSession: vi.fn().mockResolvedValue({ sessionId: input.sessionId }),
    sendTurn: vi.fn(async ({ turnId }) => {
      if (reply !== null) {
        listener({
          type: 'content.delta',
          sessionId: input.sessionId,
          turnId,
          delta: reply,
        } as ProviderRuntimeEvent);
        listener({
          type: 'turn.completed',
          sessionId: input.sessionId,
          turnId,
          outcome,
        } as ProviderRuntimeEvent);
      }
      return { turnId };
    }),
    stopAll,
  } as unknown as ProviderAdapter;
  return { value, stopAll, unsubscribe };
}

afterEach(() => vi.useRealTimers());

it('requires a real completed reply and always stops the adapter', async () => {
  const fake = adapter('SWITCH_CONNECTION_OK');
  await verifyModelTurn(fake.value, input);
  expect(fake.stopAll).toHaveBeenCalledOnce();
  expect(fake.unsubscribe).toHaveBeenCalledOnce();
});

it.each([
  ['', 'completed'],
  ['SWITCH_CONNECTION_OK', 'failed'],
])('rejects an unsuccessful check (%s, %s)', async (reply, outcome) => {
  const fake = adapter(reply, outcome);
  await expect(verifyModelTurn(fake.value, input)).rejects.toThrow('did not complete');
  expect(fake.stopAll).toHaveBeenCalledOnce();
});

it('stops a hung provider after the deadline', async () => {
  vi.useFakeTimers();
  const fake = adapter(null);
  const check = expect(verifyModelTurn(fake.value, input)).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(90001);
  await check;
  expect(fake.stopAll).toHaveBeenCalledOnce();
});

it('cleans up when starting the session fails', async () => {
  const fake = adapter(null);
  vi.mocked(fake.value.startSession).mockRejectedValue(new Error('Unauthorized'));
  await expect(verifyModelTurn(fake.value, input)).rejects.toThrow('Unauthorized');
  expect(fake.stopAll).toHaveBeenCalledOnce();
});
