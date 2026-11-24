import type { ProviderSubscriptionUsageResult } from '@switch-console/agent-providers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderUsageState } from '@shared/core/provider-usage/provider-usage';
import { ProviderUsageService, type UsageTarget } from './provider-usage-service';

const read = (
  providerId = 'a',
  accountFingerprint = 'account-a'
): ProviderSubscriptionUsageResult => ({
  providerId,
  accountFingerprint,
  status: 'ok',
  planLabel: 'Plan',
  updatedAt: Date.now(),
  windows: [{ id: 'week', label: '7d', usedPercent: 36, windowMinutes: 10_080, resetsAt: null }],
});
const failure = (
  status: 'error' | 'unauthenticated',
  extra?: Partial<ProviderSubscriptionUsageResult>
): ProviderSubscriptionUsageResult => ({
  providerId: 'a',
  status,
  updatedAt: null,
  windows: [],
  message: 'Safe reason',
  ...extra,
});

function setup(targets?: UsageTarget[]) {
  const fetch = vi.fn(async () => read());
  const publish = vi.fn<(state: ProviderUsageState) => void>();
  const targetsList = targets ?? [{ id: 'a', binaryPath: 'cli-a', read: fetch }];
  const list = vi.fn(() => targetsList);
  const service = new ProviderUsageService({
    targets: list,
    context: () => ({ cwd: '.', env: {} }),
    publish,
  });
  return { service, fetch, publish, list };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-04-05T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

it('runs no CLI or discovery by default, then polls only while enabled and active', async () => {
  const { service, fetch, list } = setup();
  service.setActive(true);
  service.handleSystemResume();
  service.handleDependenciesChanged();
  service.handleLoginExit({ providerId: 'a', exitCode: 0, error: null });
  await service.refresh();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(fetch).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();

  service.setEnabled(true);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  service.setEnabled(false);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(service.getSnapshots().snapshots).toEqual([]);
});

it('caps concurrency at three and shares the in-flight manual and automatic refresh', async () => {
  const pending = [0, 1, 2, 3].map(() => Promise.withResolvers<ProviderSubscriptionUsageResult>());
  const reads = pending.map(({ promise }) => vi.fn(() => promise));
  const { service } = setup(
    reads.map((read, index) => ({ id: String(index), binaryPath: String(index), read }))
  );
  service.setEnabled(true);
  service.setActive(true);
  const first = service.refresh();
  const second = service.refresh('0');
  expect(reads.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 0]);
  pending[0]!.resolve(read('0'));
  await second;
  expect(reads[3]).toHaveBeenCalledOnce();
  pending.slice(1).forEach(({ resolve }, index) => resolve(read(String(index + 1))));
  expect((await first).refreshingProviderIds).toEqual([]);
  expect(reads.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1]);
});

it('backs off all triggers and bypasses backoff after a successful sign-in', async () => {
  const { service, fetch } = setup();
  fetch.mockResolvedValueOnce(failure('error', { retryAt: Date.now() + 600_000 }));
  service.setEnabled(true);
  service.setActive(true);
  await service.refresh();
  service.handleSystemResume();
  service.handleSystemResume();
  await vi.advanceTimersByTimeAsync(300_000);
  await service.refresh('a');
  service.handleLoginExit({ providerId: 'a', exitCode: 1, error: null });
  expect(fetch).toHaveBeenCalledOnce();

  service.handleLoginExit({ providerId: 'a', exitCode: 0, error: null });
  await service.refresh('a');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(service.getSnapshots().snapshots[0]?.status).toBe('ok');
});

it('debounces resume and throttles repeat manual refreshes', async () => {
  const { service, fetch } = setup();
  service.setEnabled(true);
  service.setActive(true);
  await service.refresh();
  service.handleSystemResume();
  await vi.advanceTimersByTimeAsync(2_000);
  service.handleSystemResume();
  await vi.advanceTimersByTimeAsync(2_999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await service.refresh('a');
  await service.refresh('a');
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5_000);
  await service.refresh('a');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it.each(['deactivate', 'dispose'] as const)(
  '%s aborts tracked reads and discards their late values',
  async (action) => {
    const pending = Promise.withResolvers<ProviderSubscriptionUsageResult>();
    const fetch = vi.fn((input: { signal: AbortSignal }) => {
      input.signal.addEventListener('abort', () => pending.resolve(read()), { once: true });
      return pending.promise;
    });
    const { service, publish } = setup([{ id: 'a', binaryPath: 'cli-a', read: fetch }]);
    service.setEnabled(true);
    service.setActive(true);
    const refreshing = service.refresh('a');
    if (action === 'dispose') service.dispose();
    else service.setActive(false);
    expect(fetch.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await refreshing;
    expect(publish.mock.lastCall?.[0].snapshots).toEqual([]);
  }
);

it('preserves the original successful timestamp only for transient failures on the same account', async () => {
  const { service, fetch } = setup();
  const first = read();
  fetch.mockResolvedValueOnce(first);
  service.setEnabled(true);
  service.setActive(true);
  await service.refresh('a');
  expect(service.getSnapshots().snapshots[0]).not.toHaveProperty('accountFingerprint');
  fetch.mockResolvedValueOnce(failure('error', { accountFingerprint: 'account-a' }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await service.refresh('a')).snapshots[0]).toMatchObject({
    windows: first.windows,
    planLabel: 'Plan',
    updatedAt: first.updatedAt,
    stale: true,
    staleError: 'Safe reason',
  });

  fetch.mockResolvedValueOnce(failure('error', { accountFingerprint: 'account-b' }));
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await service.refresh('a')).snapshots[0]).toMatchObject({ status: 'error', windows: [] });
  expect(service.getSnapshots().snapshots[0]).not.toHaveProperty('planLabel');
});

it('clears the previous plan and quota when signed out, then refreshes on login', async () => {
  const { service, fetch } = setup();
  service.setEnabled(true);
  service.setActive(true);
  await service.refresh('a');
  fetch.mockResolvedValueOnce(failure('unauthenticated'));
  expect((await service.refresh('a')).snapshots[0]).toMatchObject({
    status: 'unauthenticated',
    windows: [],
  });
  expect(service.getSnapshots().snapshots[0]).not.toHaveProperty('planLabel');

  service.handleLoginExit({ providerId: 'a', exitCode: 0, error: null });
  expect((await service.refresh('a')).snapshots[0]?.status).toBe('ok');
});

it('reconciles changed CLIs immediately and lists an installed provider without a reader', async () => {
  const fetch = vi.fn(async () => read());
  const targets: UsageTarget[] = [{ id: 'a', binaryPath: 'first', read: fetch }];
  const { service } = setup(targets);
  service.setEnabled(true);
  service.setActive(true);
  await service.refresh();
  targets.splice(
    0,
    1,
    { id: 'b', binaryPath: 'second', read: fetch },
    { id: 'c', binaryPath: 'third' }
  );
  service.handleDependenciesChanged();
  const state = await service.refresh('b');
  expect(state.installedProviderIds).toEqual(['b', 'c']);
  expect(state.snapshots).toEqual([expect.objectContaining({ providerId: 'b' })]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
