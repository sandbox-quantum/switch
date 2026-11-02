/**
 * The sidebar's Rooms list: each row's ⋯ button and right-click offer Archive
 * (Unarchive once archived), and the rooms this person archived sit in a
 * folded Archived section at the end, closed until opened.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

const state = vi.hoisted(() => ({
  rooms: [] as RemoteRoomSummary[],
  run: (_roomId: string) => {},
}));

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/features/managed-agents/managed-agent-list', () => ({
  ManagedAgentList: () => null,
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useManagedAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/features/switch-buddy/buddy-pending', () => ({ useBuddyPending: () => false }));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 'srv' },
}));
vi.mock('@renderer/features/switch-servers/use-listed-rooms', () => ({
  useListedRoomsInActiveScope: () => state.rooms,
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ agent_chats: true }),
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useCurrentViewId: () => 'home' }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {} }));
vi.mock('@renderer/features/chats/components/unread-badge', () => ({ UnreadBadge: () => null }));
vi.mock('@renderer/features/sidebar/sidebar-room-grouping', () => ({
  isRoomViewActive: () => false,
  openRoomView: () => {},
}));
vi.mock('@renderer/features/switch-rooms/room-archive', () => ({
  roomArchiveAction: (roomId: string) => {
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return null;
    return {
      label: room.archivedByViewer ? 'Unarchive' : 'Archive',
      run: () => state.run(roomId),
    };
  },
}));

import { SidebarMainSection } from '@renderer/features/sidebar/main-section';

function room(id: string, extra: Partial<RemoteRoomSummary> = {}): RemoteRoomSummary {
  return {
    id,
    name: id,
    description: '',
    channelType: 'channel_public',
    agentCount: 1,
    bridgeDisplayName: null,
    bridgeType: null,
    externalChannelUrl: null,
    ownerId: 'someone-else',
    viewerIsMember: true,
    isConsoleChat: false,
    archived: false,
    archivedByViewer: false,
    createdAt: '',
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.setItem('sidebar.mainTab', 'rooms');
  state.rooms = [
    room('check long threads', { isConsoleChat: true }),
    room('support', { bridgeType: 'slack', bridgeDisplayName: 'Slack' }),
    room('old launch', {
      bridgeType: 'discord',
      bridgeDisplayName: 'Discord',
      archivedByViewer: true,
    }),
  ];
  state.run = vi.fn();
  container = document.createElement('div');
  container.style.width = '280px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<SidebarMainSection />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem('sidebar.mainTab');
});

function rowNames(): string[] {
  return [...container.querySelectorAll('[aria-label="Rooms"] [title]')].map(
    (el) => el.getAttribute('title') ?? ''
  );
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent === label
  );
}

it('folds the archived rooms away, closed, and counts only the others', async () => {
  expect(rowNames()).toEqual(['check long threads', 'support · Slack']);
  const fold = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Archived')
  );
  expect(fold?.textContent).toBe('Archived (1)');
  expect(fold?.getAttribute('aria-expanded')).toBe('false');
  expect(container.textContent).toContain('2');

  await act(async () => fold!.click());
  expect(rowNames()).toEqual(['check long threads', 'support · Slack', 'old launch · Discord']);
});

it('offers Archive from the ⋯ button of a bridged room, and runs it', async () => {
  const trigger = container.querySelector<HTMLElement>('[aria-label="Actions for support"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  await vi.waitFor(() => expect(menuItem('Archive')).toBeDefined());
  await act(async () => menuItem('Archive')!.click());
  expect(state.run).toHaveBeenCalledWith('support');
});

it('offers the same action on right-click, and Unarchive for an archived room', async () => {
  const fold = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Archived')
  );
  await act(async () => fold!.click());
  const row = container.querySelector<HTMLElement>('[title="old launch · Discord"]');
  await act(async () => {
    row!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
  });
  await vi.waitFor(() => expect(menuItem('Unarchive')).toBeDefined());
  await act(async () => menuItem('Unarchive')!.click());
  expect(state.run).toHaveBeenCalledWith('old launch');
});
