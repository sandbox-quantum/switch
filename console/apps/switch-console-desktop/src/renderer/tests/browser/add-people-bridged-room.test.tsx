/**
 * Adding people to a bridged room from its participant column.
 *
 * Someone who linked their chat account to Switch is offered by their full
 * name, with the username beside it, and can be found by either; the room is
 * still given the username, since that is what the messaging app knows.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listBridgePeople = vi.hoisted(() => vi.fn());
const addRoomUsers = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { workspaces: { listBridgePeople, addRoomUsers } },
  events: { on: () => () => {}, emit: () => {} },
}));

import { AddPeoplePanel } from '@renderer/features/switch-rooms/room-add-participants';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';

const ROOM = {
  id: 'room-1',
  bridgeDisplayName: 'Slack',
  connectedUserNames: ['already.here'],
} as unknown as RemoteRoomDetail;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  listBridgePeople.mockResolvedValue([
    {
      username: 'simon.flack',
      externalUserId: 'U1',
      linkedUserIds: ['u1'],
      linkedName: 'Simon Flack',
    },
    {
      username: 'ada',
      externalUserId: 'U2',
      linkedUserIds: [],
      linkedName: null,
    },
    {
      username: 'already.here',
      externalUserId: 'U3',
      linkedUserIds: [],
      linkedName: 'Here Already',
    },
  ]);
  addRoomUsers.mockImplementation(async () => ({
    ...ROOM,
    connectedUserNames: ['already.here', 'simon.flack'],
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AddPeoplePanel workspaceId="ws-1" room={ROOM} bridgeId="bridge-1" />
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
  return container;
}

async function search(el: HTMLElement, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(
    'input[aria-label="Search for a person to add"]'
  )!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Each offered row as "name · detail", leaving out the avatar's initials. */
function rows(el: HTMLElement): string[] {
  return addButtons(el).map((button) => {
    const name = button.querySelector('.truncate')?.textContent;
    const detail = button.querySelector('.truncate + span')?.textContent;
    return `${name} · ${detail}`;
  });
}

function addButtons(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll('button')].filter((b) => b.textContent?.endsWith('Add'));
}

describe('adding people to a bridged room', () => {
  it('lists a linked person by full name with their username, and leaves out who is here', async () => {
    const el = await render();
    expect(rows(el)).toEqual(['ada · @ada', 'Simon Flack · @simon.flack']);
  });

  it('finds a person by their full name', async () => {
    const el = await render();
    await search(el, 'simon fl');
    expect(rows(el)).toEqual(['Simon Flack · @simon.flack']);
  });

  it('finds a person by their username', async () => {
    const el = await render();
    await search(el, 'simon.f');
    expect(rows(el)).toEqual(['Simon Flack · @simon.flack']);
  });

  it('gives the room the username, not the name shown', async () => {
    const el = await render();
    await search(el, 'Simon');
    await act(async () => addButtons(el)[0]!.click());
    expect(addRoomUsers).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      userNames: ['simon.flack'],
    });
  });
});
