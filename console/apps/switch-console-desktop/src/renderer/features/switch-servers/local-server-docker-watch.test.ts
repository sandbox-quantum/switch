import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DockerAvailability,
  LocalServerStatus,
} from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * The server page and the setup page both wait on Docker: the Mattermost
 * switch, and a Docker server's Start button. People open the page, find it
 * greyed out, and only then start Docker Desktop — so an answer read once when
 * the page opened left it greyed out until they navigated away and back.
 */

const detectDocker = vi.hoisted(() => vi.fn<() => Promise<DockerAvailability>>());
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { localSwitchServer: { detectDocker } },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({ agentsStore: {} }));
vi.mock('./switch-servers-store', () => ({
  switchServersStore: { init: () => Promise.resolve() },
}));

const { LocalServerStore } = await import('./local-server-store');

const DOWN: DockerAvailability = {
  available: false,
  reason: 'daemon-down',
  detail: 'Docker is installed but the daemon is not running.',
};
const UP: DockerAvailability = { available: true, version: '28.0.0' };

beforeEach(() => {
  vi.useFakeTimers();
  detectDocker.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watching for Docker', () => {
  it('notices Docker started after the page opened', async () => {
    detectDocker.mockResolvedValue(DOWN);
    const store = new LocalServerStore();
    const stop = store.watchDocker();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.docker?.available).toBe(false);

    detectDocker.mockResolvedValue(UP);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.docker?.available).toBe(true);
    stop();
  });

  it('stops asking once Docker is there', async () => {
    detectDocker.mockResolvedValue(UP);
    const store = new LocalServerStore();
    const stop = store.watchDocker();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(detectDocker).toHaveBeenCalledTimes(1);
    stop();
  });

  it('asks again if a start finds Docker gone', async () => {
    detectDocker.mockResolvedValue(UP);
    const store = new LocalServerStore();
    const stop = store.watchDocker();
    await vi.advanceTimersByTimeAsync(0);

    store.docker = DOWN;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(detectDocker).toHaveBeenCalledTimes(2);
    expect(store.docker?.available).toBe(true);
    stop();
  });

  it('stops when the last page watching closes', async () => {
    detectDocker.mockResolvedValue(DOWN);
    const store = new LocalServerStore();
    const stopServerPage = store.watchDocker();
    const stopSetupPage = store.watchDocker();
    await vi.advanceTimersByTimeAsync(0);
    detectDocker.mockClear();

    stopServerPage();
    // A cleanup run twice must not take the other page's watch with it.
    stopServerPage();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(detectDocker).toHaveBeenCalledTimes(1);

    stopSetupPage();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(detectDocker).toHaveBeenCalledTimes(1);
  });

  it('leaves the Mattermost switch off, and free to turn on, when Docker comes up after the start', async () => {
    detectDocker.mockResolvedValue(DOWN);
    const store = new LocalServerStore();
    // Never chosen, and the start found no Docker, so it went without.
    store.status = {
      phase: 'running',
      mattermost: null,
      mattermostState: 'off',
    } as LocalServerStatus;
    const stop = store.watchDocker();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.mattermost).toBe(false);

    detectDocker.mockResolvedValue(UP);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.docker?.available).toBe(true);
    expect(store.mattermost).toBe(false);
    stop();
  });

  it('still shows a never-chosen Mattermost on where Console has not seen the start', () => {
    const store = new LocalServerStore();
    // Console relaunched beside a server that kept running: nothing seen yet.
    store.status = {
      phase: 'running',
      mattermost: null,
      mattermostState: null,
    } as LocalServerStatus;
    store.docker = UP;
    expect(store.mattermost).toBe(true);
  });

  it('shares a slow check rather than piling more on top of it', async () => {
    let answer: (docker: DockerAvailability) => void = () => {};
    detectDocker.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const store = new LocalServerStore();
    const stop = store.watchDocker();
    // `docker version` can hang for seconds while the daemon comes up.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(detectDocker).toHaveBeenCalledTimes(1);

    answer(UP);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.docker?.available).toBe(true);
    stop();
  });
});
