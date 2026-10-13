import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedChat } from '@shared/core/switch-servers/switch-servers';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const state = vi.hoisted(() => ({
  chats: [] as ConnectedChat[],
  listConnectedChats: vi.fn(),
  disconnectChat: vi.fn(),
  confirmations: [] as { title: string; description: string; onSuccess: () => void }[],
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspaces: {
      listConnectedChats: state.listConnectedChats,
      disconnectChat: state.disconnectChat,
    },
  },
}));

// The confirmation is the shared registry dialog; what matters here is what
// it is asked and what happens once it is confirmed.
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => (args: { title: string; description: string; onSuccess: () => void }) =>
    state.confirmations.push(args),
}));

/**
 * The chats under the Switch Telegram app's connection. A Slack workspace or a
 * Discord server is a connection of its own, and so a row of its own; these
 * share one connection, so they are listed under it, each with a way out.
 */
import { ConnectedChatsList } from '@renderer/features/switch-servers/ConnectedChatsList';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.chats = [
    { id: 'i-1', name: 'Ops', externalId: '-1001', connectedAt: '2026-09-01T10:00:00Z' },
    { id: 'i-2', name: null, externalId: '-1002', connectedAt: '2026-09-01T10:00:00Z' },
  ];
  state.confirmations = [];
  state.listConnectedChats.mockReset().mockImplementation(async () => state.chats);
  state.disconnectChat.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

async function render(onDisconnected: () => void = () => {}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ConnectedChatsList
          workspaceId="ws-1"
          bridgeId="b-tg"
          platformLabel="Telegram"
          onDisconnected={onDisconnected}
        />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

function disconnectButtons(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Disconnect');
}

describe('the list', () => {
  it('names each chat, by its chat id when it has no name', async () => {
    const el = await render();

    expect(state.listConnectedChats).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-tg',
    });
    expect(el.textContent).toContain('Ops');
    expect(el.textContent).toContain('-1002');
    expect(disconnectButtons(el)).toHaveLength(2);
  });

  it('says so when no chat is connected', async () => {
    state.chats = [];

    const el = await render();

    expect(el.textContent).toContain('No chats connected.');
  });
});

describe('disconnecting', () => {
  it('asks first, saying the room stays', async () => {
    const el = await render();

    await act(async () => disconnectButtons(el)[0].click());

    expect(state.confirmations).toHaveLength(1);
    expect(state.confirmations[0].title).toBe('Disconnect Ops?');
    expect(state.confirmations[0].description).toContain('Its room stays in Switch');
    expect(state.disconnectChat).not.toHaveBeenCalled();
  });

  it('disconnects that chat once confirmed, and refreshes', async () => {
    const onDisconnected = vi.fn();
    const el = await render(onDisconnected);
    await act(async () => disconnectButtons(el)[0].click());
    state.chats = [state.chats[1]];

    await act(async () => state.confirmations[0].onSuccess());
    await settle();

    expect(state.disconnectChat).toHaveBeenCalledWith({ workspaceId: 'ws-1', installId: 'i-1' });
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(el.textContent).not.toContain('Ops');
  });

  it('says why when the server refuses', async () => {
    state.disconnectChat.mockRejectedValue(
      new Error('Telegram did not let the bot leave; disconnect again to retry.')
    );
    const onDisconnected = vi.fn();
    const el = await render(onDisconnected);
    await act(async () => disconnectButtons(el)[0].click());

    await act(async () => state.confirmations[0].onSuccess());
    await settle();

    expect(el.textContent).toContain('Could not disconnect Ops.');
    expect(el.textContent).toContain('Telegram did not let the bot leave');
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});
