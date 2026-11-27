/**
 * In real CSS: the sidebar's Rooms list holds the rooms on no messaging app,
 * and a banner above New Room leads to Settings → Messaging apps for the rest.
 * Saves screenshots under the app's gitignored `build/acceptance/rooms-sidebar/`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@renderer/index.css';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const navigate = vi.hoisted(() => vi.fn());
const ROOMS = vi.hoisted(() =>
  [
    { id: 'planning', name: 'Planning', bridgeType: null },
    { id: 'support', name: 'support-escalations', bridgeType: 'slack' },
    { id: 'launch', name: 'launch-party', bridgeType: 'discord' },
    { id: 'retro', name: 'Retro', bridgeType: null },
  ].map((room) => ({
    ...room,
    bridgeDisplayName: room.bridgeType === null ? null : 'Acme',
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
  }))
);
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { navigate, currentViewId: 'home', viewParamsStore: {} } },
}));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: { unread: () => 0, chat: () => undefined },
  chatTitler: {},
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 's' },
}));
vi.mock('@renderer/features/switch-servers/use-listed-rooms', () => ({
  useListedRoomsInActiveScope: () => ROOMS,
}));
vi.mock('@renderer/features/managed-agents/managed-agent-list', () => ({
  ManagedAgentList: () => null,
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useManagedAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/features/switch-buddy/buddy-pending', () => ({ useBuddyPending: () => false }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ agent_chats: true }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));

import { ChatHostProvider } from '@switch-console/chat-ui/host';
import type { ChatsStore } from '@switch-console/chat-ui/stores/chats-store';
import { stubChatHost } from '@switch-console/chat-ui/testing';
import { SidebarMainSection } from '@renderer/features/sidebar/main-section';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';

const SHOTS = '../../../../build/acceptance/rooms-sidebar';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  localStorage.clear();
  document.documentElement.classList.remove('emdark');
});

async function mountRoomsTab(): Promise<HTMLElement> {
  localStorage.setItem('sidebar.mainTab', 'rooms');
  document.documentElement.classList.add('emdark');
  container = document.createElement('div');
  container.className = 'inline-block w-[260px] bg-background p-2 text-foreground';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <ChatHostProvider
        host={stubChatHost({
          chats: { unread: () => 0 } as unknown as ChatsStore,
          BridgeIcon,
          hasBridgeIcon,
        })}
      >
        <SidebarMainSection />
      </ChatHostProvider>
    )
  );
  return container;
}

it('lists only the rooms on no messaging app, and counts only those', async () => {
  const el = await mountRoomsTab();
  await page.viewport(400, 400);
  const names = [...el.querySelectorAll('[aria-label="Rooms"] [title] span.truncate')].map(
    (span) => span.textContent
  );
  expect(names.sort()).toEqual(['Planning', 'Retro']);
  expect(el.textContent).not.toContain('support-escalations');
  expect(el.textContent).not.toContain('launch-party');
  expect(el.querySelector('[aria-label="Show rooms on these apps"]')).toBeNull();
  expect(el.querySelector('section span.tabular-nums')?.textContent).toBe('2');
  await page.screenshot({ path: `${SHOTS}/rooms-in-app-only.png`, element: el });
});

it('leads to Settings → Messaging apps from a banner above New Room', async () => {
  const el = await mountRoomsTab();
  await page.viewport(400, 400);
  const list = page.elementLocator(el.querySelector<HTMLElement>('div[aria-label="Rooms"]')!);
  const banner = list.getByRole('button', { name: 'Connect a messaging app' });
  const buttons = list.getByRole('button').elements();
  expect(buttons.indexOf(banner.element() as HTMLElement)).toBe(0);
  expect(buttons[1].textContent?.trim()).toBe('New Room');
  expect(
    banner.element().querySelectorAll('[aria-hidden] svg, [aria-hidden] img').length
  ).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: `${SHOTS}/messaging-banner.png`, element: el });
  await banner.click();
  expect(navigate).toHaveBeenCalledWith('settings', { tab: 'messaging-apps' });
});
