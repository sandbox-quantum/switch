import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
/**
 * In real CSS: a Console room's own Add participants button and its people in
 * their colours, and an agent's power and move buttons beside its Connectors
 * and settings. Saves screenshots under the app's gitignored
 * `build/acceptance/rooms-sidebar/`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Laptop } from 'lucide-react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import '@renderer/index.css';
import { page } from 'vitest/browser';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const chat = vi.hoisted(() => ({ current: null as ChatSummary | null }));
const setDesiredState = vi.hoisted(() => vi.fn());
const showModal = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: {
    serverId: 's',
    removed: new Set(),
    chat: () => chat.current ?? undefined,
    add: vi.fn(),
  },
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ group_chats: true }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => showModal }));
vi.mock('@renderer/features/managed-agents/use-managed-agent-actions', () => ({
  useManagedAgentActions: () => ({ busy: false, setDesiredState, remove: vi.fn() }),
}));

import { ChatHostProvider } from '@switch-console/chat-ui/host';
import { stubChatHost } from '@switch-console/chat-ui/testing';
import { chatMembersQueryKey } from '@renderer/features/chats/chat-people';
import { AgentProfile } from '@renderer/features/managed-agents/agent-profile';
import { AgentProfileActions } from '@renderer/features/managed-agents/agent-profile-actions';
import { RoomSidePanel } from '@renderer/features/switch-rooms/room-side-panel';
// The profile draws Console's own avatars.
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

const SHOTS = '../../../../build/acceptance/rooms-sidebar';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.classList.remove('emdark');
});

async function mount(node: React.ReactNode, client = new QueryClient()): Promise<HTMLElement> {
  document.documentElement.classList.add('emdark');
  container = document.createElement('div');
  container.className = 'inline-block bg-background text-foreground';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ChatHostProvider host={stubChatHost({ AgentAvatar })}>{node}</ChatHostProvider>
      </QueryClientProvider>
    )
  );
  return container;
}

it('gives a Console room its own Add participants button, and each person a colour', async () => {
  chat.current = {
    roomId: 'r',
    name: 'Planning',
    channelType: 'channel_private',
    bridgeType: null,
    channelName: null,
    agents: [
      {
        id: 'agent-1',
        name: 'helper',
        displayName: 'Helper',
        iconUrl: null,
        provider: null,
        alias: null,
        ownerName: null,
        ownedByViewer: false,
      },
    ],
    canManage: true,
    ownsAgent: false,
    memberUserIds: ['u1', 'u2', 'u3', 'u4'],
    memberCount: 4,
    unreadCount: 0,
    lastMessage: null,
  };
  const client = new QueryClient();
  client.setQueryData(chatMembersQueryKey('s', chat.current), [
    { userId: 'u1', name: 'Simon Flack', isOwner: true },
    { userId: 'u2', name: 'Louis Amaudruz', isOwner: false },
    { userId: 'u3', name: 'Louis Amaudruz', isOwner: false },
    { userId: 'u4', name: 'Max Tam', isOwner: false },
  ]);
  const el = await mount(<RoomSidePanel roomId="r" />, client);

  const add = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Add participants'
  );
  expect(add).toBeTruthy();
  expect(el.querySelector('[aria-label="Add agents"]')).toBeNull();
  // Two people who share a name are told apart by their colour.
  const louis = [...el.querySelectorAll('section[aria-label="People"] span[style]')]
    .filter((disc) => disc.textContent === 'LA')
    .map((disc) => (disc as HTMLElement).style.backgroundColor);
  expect(louis).toHaveLength(2);
  expect(louis[0]).not.toBe(louis[1]);

  await page.viewport(400, 600);
  await page.screenshot({ path: `${SHOTS}/room-side-panel.png`, element: el });
});

it('puts turning the agent off and moving it beside its Connectors and settings', async () => {
  const agent = { desiredState: 'running' } as ManagedAgentView;
  const el = await mount(
    <div style={{ width: 300 }}>
      <AgentProfile
        name="Flint Code Assistant"
        iconUrl={null}
        serverId="s"
        machine={{ icon: Laptop, text: 'This computer', status: null, title: '' }}
        sections={['connections', 'settings']}
        selected={null}
        onSelect={() => {}}
        onOpenMachine={null}
        actions={<AgentProfileActions agent={agent} />}
      />
    </div>
  );

  const toolbar = el.querySelector('[role="toolbar"]')!;
  expect([...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
    'Connectors',
    'Agent settings',
    'Turn off agent',
    'Move to another device…',
  ]);
  await act(async () =>
    (toolbar.querySelector('[aria-label="Turn off agent"]') as HTMLElement).click()
  );
  expect(setDesiredState).toHaveBeenCalledWith('stopped');
  await act(async () =>
    (toolbar.querySelector('[aria-label="Move to another device…"]') as HTMLElement).click()
  );
  expect(showModal).toHaveBeenCalledWith({ agent });

  await page.viewport(400, 400);
  await page.screenshot({ path: `${SHOTS}/agent-profile.png`, element: el });
});
