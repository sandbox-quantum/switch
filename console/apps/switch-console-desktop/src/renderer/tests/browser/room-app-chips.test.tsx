/**
 * In real CSS: the chip row above the sidebar's Rooms list narrows it to one
 * messaging app. Saves screenshots under the app's gitignored
 * `build/acceptance/rooms-sidebar/`.
 */
import { act, useState } from 'react';
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

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
import { RoomRow } from '@switch-console/chat-ui/components/chat-row';
import { ChatHostProvider } from '@switch-console/chat-ui/host';
import type { ChatsStore } from '@switch-console/chat-ui/stores/chats-store';
import { stubChatHost } from '@switch-console/chat-ui/testing';
import { RoomAppChips } from '@renderer/features/sidebar/room-app-chips';
import { appsOf, inApp } from '@renderer/features/switch-servers/room-apps';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';

// The rows as Console draws them: its own messaging-app icons, and a room with three unread.
const host = stubChatHost({
  chats: { unread: (roomId: string) => (roomId === 'planning' ? 3 : 0) } as unknown as ChatsStore,
  hasBridgeIcon,
  BridgeIcon,
});

const SHOTS = '../../../../build/acceptance/rooms-sidebar';

const ROOMS = [
  { id: 'planning', name: 'Planning', bridgeType: null, bridgeDisplayName: null },
  { id: 'support', name: 'support-escalations', bridgeType: 'slack', bridgeDisplayName: 'Acme' },
  { id: 'releases', name: 'releases', bridgeType: 'slack', bridgeDisplayName: 'Acme' },
  { id: 'launch', name: 'launch-party', bridgeType: 'discord', bridgeDisplayName: 'Friends' },
];

function Rooms({ initial }: { initial: string | null }) {
  const [app, setApp] = useState<string | null>(initial);
  return (
    <ChatHostProvider host={host}>
      <div className="flex w-[260px] flex-col gap-[2px] bg-background p-2 text-foreground">
        <RoomAppChips apps={appsOf(ROOMS)} selected={app} onSelect={setApp} />
        {inApp(ROOMS, app).map((room) => (
          <RoomRow key={room.id} roomId={room.id} room={room} isActive={false} onOpen={() => {}} />
        ))}
      </div>
    </ChatHostProvider>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.classList.remove('emdark');
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  document.documentElement.classList.add('emdark');
  container = document.createElement('div');
  container.className = 'inline-block';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

const names = (el: HTMLElement) =>
  [...el.querySelectorAll('span.truncate')].map((span) => span.textContent);

it('narrows the rooms to one messaging app, and back to all of them', async () => {
  const el = await mount(<Rooms initial={null} />);
  await page.viewport(400, 400);
  expect(names(el)).toEqual(['Planning', 'support-escalations', 'releases', 'launch-party']);
  await page.screenshot({ path: `${SHOTS}/room-app-chips-all.png`, element: el });

  const chip = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  await act(async () => chip('Slack').click());
  expect(names(el)).toEqual(['support-escalations', 'releases']);
  expect(chip('Slack').getAttribute('aria-pressed')).toBe('true');
  await page.screenshot({ path: `${SHOTS}/room-app-chips-slack.png`, element: el });

  await act(async () => chip('All').click());
  expect(names(el)).toHaveLength(4);
});

it('offers no chips when every room is on one app', async () => {
  const only = ROOMS.filter((room) => room.bridgeType === 'slack');
  const el = await mount(<RoomAppChips apps={appsOf(only)} selected={null} onSelect={() => {}} />);
  expect(el.querySelector('button')).toBeNull();
});
