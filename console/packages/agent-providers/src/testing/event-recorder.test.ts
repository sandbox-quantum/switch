import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import { EventRecorder } from './event-recorder';

afterEach(() => vi.useRealTimers());

it('cancels pending waits and releases their timers when disposed', async () => {
  vi.useFakeTimers();
  const unsubscribe = vi.fn();
  const adapter = { subscribe: () => unsubscribe } as unknown as ProviderAdapter;
  const recorder = new EventRecorder(adapter);
  const waiting = recorder.waitFor('turn.completed', undefined, 300_000);
  const result = expect(waiting).rejects.toThrow('Event recorder disposed');

  recorder.dispose();
  recorder.dispose();

  await result;
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await expect(recorder.waitFor('turn.completed')).rejects.toThrow('Event recorder disposed');
});
