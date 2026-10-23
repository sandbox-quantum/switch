import { describe, expect, it, vi } from 'vitest';
import type {
  DockerAvailability,
  LocalServerStatus,
} from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * The server page notices Docker coming up while it is open. A running server
 * that went without Mattermost (Docker down at start, so left out or failed to
 * come up) has to show the switch off and free to turn on then, not on with
 * nothing running, where the only click turns it off and getting Mattermost up
 * takes a toggle off and on or a restart.
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

function status(
  phase: LocalServerStatus['phase'],
  mattermost: boolean | null,
  mattermostState: LocalServerStatus['mattermostState']
): LocalServerStatus {
  return { phase, mattermost, mattermostState } as LocalServerStatus;
}

async function storeWith(given: LocalServerStatus, docker: DockerAvailability) {
  const store = new LocalServerStore();
  store.status = given;
  detectDocker.mockResolvedValue(docker);
  await store.checkDocker();
  return store;
}

describe('the Mattermost switch on a running server', () => {
  it('stays off when Docker comes up after a start that left Mattermost out', async () => {
    const store = await storeWith(status('running', null, 'off'), DOWN);
    expect(store.mattermost).toBe(false);

    detectDocker.mockResolvedValue(UP);
    await store.checkDocker();

    expect(store.docker?.available).toBe(true);
    expect(store.mattermost).toBe(false);
  });

  it('reads off when Mattermost was turned on but failed to come up, so a click retries', async () => {
    const store = await storeWith(status('running', true, 'failed'), UP);
    expect(store.mattermost).toBe(false);
  });

  it('reads on while Mattermost is up or coming up, whatever Docker last said', async () => {
    expect((await storeWith(status('running', null, 'running'), DOWN)).mattermost).toBe(true);
    expect((await storeWith(status('running', null, 'starting'), DOWN)).mattermost).toBe(true);
  });

  it('falls back to the setting where Console has not seen the start', async () => {
    // Console relaunched beside a server that kept running: nothing seen yet.
    expect((await storeWith(status('running', null, null), UP)).mattermost).toBe(true);
    expect((await storeWith(status('running', false, null), UP)).mattermost).toBe(false);
  });
});

describe('the Mattermost switch on a stopped server', () => {
  it('says whether the next start runs it', async () => {
    expect((await storeWith(status('stopped', true, null), DOWN)).mattermost).toBe(true);
    expect((await storeWith(status('stopped', false, null), UP)).mattermost).toBe(false);
    expect((await storeWith(status('stopped', null, null), UP)).mattermost).toBe(true);
    expect((await storeWith(status('stopped', null, null), DOWN)).mattermost).toBe(false);
  });
});
