/**
 * The buddy's Welcome setup cards: a read that fails says so with a Retry,
 * whether the app was picked or found already connected, and before any app
 * is known.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModalProvider from '@renderer/lib/modal/modal-provider';

const listBridges = vi.hoisted(() => vi.fn());
const listMyIdentities = vi.hoisted(() => vi.fn());
const createChat = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspaces: { listBridges, listMyIdentities, getRoomDetail: vi.fn() },
    chats: { create: createChat },
    switchRooms: { openRoomChannel: vi.fn() },
  },
  events: { on: () => () => {}, emit: () => {} },
}));
vi.mock('@renderer/lib/modal/modal-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof ModalProvider>()),
  useShowModal: () => vi.fn(),
}));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatTitler: {},
  chatsStore: {
    chat: () => ({ name: 'Welcome', bridgeType: null }),
    add: () => {},
    timelines: { get: () => ({ messages: [], pending: [], send: () => {} }) },
  },
}));

import { BuddySetupCards } from '@renderer/features/switch-buddy/buddy-setup-cards';

const slack = {
  id: 'b-1',
  type: 'slack',
  displayName: 'Acme',
  status: 'active',
  isDefault: true,
  homeUrl: null,
  channelCreationSupported: true,
  channelCreationEnabled: true,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  listBridges.mockReset();
  listMyIdentities.mockReset().mockResolvedValue([{ bridgeId: 'b-1' }]);
  createChat.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <BuddySetupCards
          serverId="srv-1"
          workspaceId="ws-1"
          agentId="agent-1"
          agentName="buddy"
          roomId="room-1"
        />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

function retryButton(el: HTMLElement): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
  expect(found, 'no Retry button').toBeDefined();
  return found!;
}

describe('the buddy setup cards', () => {
  it('shows a failed resume on an already-connected Slack, and Retry reads it again', async () => {
    listBridges.mockResolvedValue([slack]);
    createChat.mockRejectedValueOnce(new Error('down')).mockReturnValue(new Promise(() => {}));
    const el = await render();

    expect(el.textContent).toContain('Couldn’t check Slack');
    await act(async () => retryButton(el).click());
    await settle();

    expect(createChat).toHaveBeenCalledTimes(2);
    expect(el.textContent).not.toContain('Couldn’t check');
  });

  it('shows a failed first read of the chat apps, and Retry reads them again', async () => {
    listBridges.mockRejectedValueOnce(new Error('down')).mockResolvedValue([]);
    const el = await render();

    expect(el.textContent).toContain('Couldn’t check your chat apps');
    await act(async () => retryButton(el).click());
    await settle();

    expect(listBridges).toHaveBeenCalledTimes(2);
    expect(el.textContent).not.toContain('Couldn’t check');
  });

  it('asks them to mention buddy after inviting it on Teams', async () => {
    listBridges.mockResolvedValue([{ ...slack, type: 'teams' }]);
    const el = await render();

    expect(el.textContent).toContain('!invite-agent @buddy');
    expect(el.textContent).toContain('Then mention buddy with a short note on what you work on.');
    expect(el.textContent).not.toContain("I'll answer");
  });

  it('asks them to reply to the bot on Telegram', async () => {
    listBridges.mockResolvedValue([{ ...slack, type: 'telegram' }]);
    const el = await render();

    expect(el.textContent).toContain('/invite_agent @buddy');
    expect(el.textContent).toContain("reply to the bot's message");
    expect(el.textContent).toContain('mention buddy in that reply');
  });
});
