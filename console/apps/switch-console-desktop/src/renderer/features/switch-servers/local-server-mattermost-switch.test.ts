import { describe, expect, it, vi } from 'vitest';
import type {
  DockerAvailability,
  LocalServerStatus,
} from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * A Mattermost setting nobody has chosen means "on wherever Docker can run it",
 * decided at each start. A server that started while Docker was down went
 * without Mattermost, and once the server page notices Docker coming up, the
 * switch has to show that, off and free to turn on, rather than on with
 * nothing running, where a click would turn it off.
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

function running(mattermostState: LocalServerStatus['mattermostState']): LocalServerStatus {
  return { phase: 'running', mattermost: null, mattermostState } as LocalServerStatus;
}

describe('the Mattermost switch for a setting never chosen', () => {
  it('stays off, and free to turn on, when Docker comes up after a start that went without it', async () => {
    const store = new LocalServerStore();
    store.status = running('off');
    detectDocker.mockResolvedValue(DOWN);
    await store.checkDocker();
    expect(store.mattermost).toBe(false);

    detectDocker.mockResolvedValue(UP);
    await store.checkDocker();

    expect(store.docker?.available).toBe(true);
    expect(store.mattermost).toBe(false);
  });

  it('is on where Console has not seen the start, as before', () => {
    const store = new LocalServerStore();
    // Console relaunched beside a server that kept running: nothing seen yet.
    store.status = running(null);
    store.docker = UP;
    expect(store.mattermost).toBe(true);
  });

  it('follows the choice once one is made', () => {
    const store = new LocalServerStore();
    store.status = { ...running('off'), mattermost: true };
    expect(store.mattermost).toBe(true);
  });
});
