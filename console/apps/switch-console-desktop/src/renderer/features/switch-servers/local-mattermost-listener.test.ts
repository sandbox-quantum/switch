import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalServerStatus } from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * The Mattermost beside a native local server registers its bridge and links
 * the admin's account after the server is already in use. Pages that were open
 * kept showing no Mattermost, and asking to link an account, until the server
 * was restarted.
 */

const listeners = vi.hoisted(() => [] as ((status: LocalServerStatus) => void)[]);
const refreshRoomState = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, listener: (status: LocalServerStatus) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: (serverId: string | null) => `ws-on-${serverId}` },
}));
vi.mock('./switch-rooms-store', () => ({ switchRoomsStore: { refreshRoomState } }));

const { refreshWhenLocalMattermostIsUp } = await import('./local-mattermost-listener');

const invalidateQueries = vi.fn(() => Promise.resolve());
const queryClient = { invalidateQueries } as unknown as QueryClient;

function push(mattermostState: LocalServerStatus['mattermostState']): void {
  const status = { serverId: 'local', mattermostState } as LocalServerStatus;
  for (const listener of listeners) listener(status);
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
});

describe('when the local Mattermost comes up', () => {
  it("re-reads the server's messaging apps, the linked accounts and the rooms", () => {
    const stop = refreshWhenLocalMattermostIsUp(queryClient);
    push('starting');
    expect(invalidateQueries).not.toHaveBeenCalled();

    push('running');

    expect(invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['remote-bridges', 'ws-on-local'] }],
      [{ queryKey: ['my-switch-identities', 'ws-on-local'] }],
      [{ queryKey: ['owns-owner-addressed-agent', 'ws-on-local'] }],
    ]);
    expect(refreshRoomState).toHaveBeenCalledTimes(1);
    stop();
  });

  it('re-reads once, not on every status pushed while it stays up', () => {
    const stop = refreshWhenLocalMattermostIsUp(queryClient);
    push('running');
    push('running');
    push('running');

    expect(refreshRoomState).toHaveBeenCalledTimes(1);
    stop();
  });

  it('re-reads again when it is turned off and back on', () => {
    const stop = refreshWhenLocalMattermostIsUp(queryClient);
    push('running');
    push(null);
    push('starting');
    push('running');

    expect(refreshRoomState).toHaveBeenCalledTimes(2);
    stop();
  });

  it('leaves everything alone when it fails to come up', () => {
    const stop = refreshWhenLocalMattermostIsUp(queryClient);
    push('starting');
    push('failed');

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(refreshRoomState).not.toHaveBeenCalled();
    stop();
  });
});
