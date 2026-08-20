import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStartupWatch, type StartupStall } from './session-startup-watch';

const TIMEOUT_MS = 45_000;

function makeWatch(): { watch: SessionStartupWatch; stalls: StartupStall[] } {
  const watch = new SessionStartupWatch(TIMEOUT_MS, { warn: vi.fn(), error: vi.fn() });
  const stalls: StartupStall[] = [];
  watch.onStall((stall) => stalls.push(stall));
  return { watch, stalls };
}

function begin(watch: SessionStartupWatch): void {
  watch.begin({ ptyId: 'pty-1', sessionId: 'session-1', providerId: 'claude' });
}

describe('SessionStartupWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports a stall when the session never says it started', () => {
    const { watch, stalls } = makeWatch();
    begin(watch);

    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(stalls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(stalls).toEqual([{ sessionId: 'session-1', providerId: 'claude' }]);
  });

  it('stays quiet for a session that reports in time', () => {
    const { watch, stalls } = makeWatch();
    begin(watch);

    watch.markStarted('pty-1');
    vi.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(stalls).toEqual([]);
  });

  it('reports a stall once, not on every later hook', () => {
    const { watch, stalls } = makeWatch();
    begin(watch);

    vi.advanceTimersByTime(TIMEOUT_MS);
    watch.markStarted('pty-1');
    watch.markStarted('pty-1');
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(stalls).toHaveLength(1);
  });

  it('opens the pane for a session that reports late, after it was called stalled', async () => {
    const { watch, stalls } = makeWatch();
    begin(watch);
    const started = watch.waitForStart('pty-1');

    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(stalls).toHaveLength(1);

    watch.markStarted('pty-1');
    await expect(started).resolves.toBe(true);
  });

  it('resolves false when the pty exits without ever reporting', async () => {
    const { watch } = makeWatch();
    begin(watch);
    const started = watch.waitForStart('pty-1');

    watch.end('pty-1');

    await expect(started).resolves.toBe(false);
  });

  it('does not report a stall after the pty is gone', () => {
    const { watch, stalls } = makeWatch();
    begin(watch);

    watch.end('pty-1');
    vi.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(stalls).toEqual([]);
  });

  it('resolves false for a pty it was never asked to watch', async () => {
    const { watch } = makeWatch();
    await expect(watch.waitForStart('pty-unknown')).resolves.toBe(false);
  });

  it('restarts the wait when a pty id is reused by a respawn', () => {
    const { watch, stalls } = makeWatch();
    begin(watch);
    watch.markStarted('pty-1');

    begin(watch);
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(stalls).toHaveLength(1);
  });
});
