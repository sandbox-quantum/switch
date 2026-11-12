/**
 * The New room dialog for a room on a messaging app: the channel choice, always
 * shown as cards, and More options for what is easy to change later — shut at
 * first, its row saying what each is set to.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { workspaces: { listRoomGroups: vi.fn(async () => [{ id: 'g1', name: 'Design' }]) } },
}));

import {
  CreateRoomOptions,
  RoomChannelField,
} from '@renderer/features/switch-servers/create-room-options';
import {
  DEFAULT_ROOM_OPTIONS,
  type RoomCreateOptions,
} from '@renderer/features/switch-servers/room-create-request';

const BRIDGE = {
  id: 'b1',
  type: 'slack',
  displayName: 'Acme Slack',
  channelIdsRefused: null,
  privateChannels: null,
  privateChannelNeedsLinkedAccount: false,
  publicChannelAddsCreator: false,
} as RemoteBridge;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: RoomCreateOptions = DEFAULT_ROOM_OPTIONS;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  latest = DEFAULT_ROOM_OPTIONS;
});

function Harness({ bridge, admin }: { bridge: RemoteBridge | null; admin: boolean }) {
  const [value, setValue] = useState<RoomCreateOptions>(DEFAULT_ROOM_OPTIONS);
  const onChange = (next: RoomCreateOptions) => {
    latest = next;
    setValue(next);
  };
  return (
    <>
      {bridge && <RoomChannelField bridge={bridge} value={value} onChange={onChange} />}
      <CreateRoomOptions
        workspaceId="ws-1"
        value={value}
        onChange={onChange}
        administersWorkspace={admin}
        bridged={bridge !== null}
      />
    </>
  );
}

async function render(bridge: RemoteBridge | null = BRIDGE, admin = true): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Harness bridge={bridge} admin={admin} />
      </QueryClientProvider>
    )
  );
  return container;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

function radio(el: HTMLElement, title: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) =>
    b.textContent?.startsWith(title)
  );
}

describe('creating a room on a messaging app', () => {
  it('shows the channel choice as cards, a new public channel picked', async () => {
    const el = await render();
    expect(radio(el, 'New public channel')!.getAttribute('aria-checked')).toBe('true');
    expect(el.textContent).toContain('Anyone in the Slack workspace can find and join it.');
    expect(el.textContent).toContain('Console can’t move a room to another channel later.');
  });

  it('says what More options holds while shut: no group, open to the workspace', async () => {
    const el = await render();
    expect(el.textContent).toContain('Group: none · Public — read & write');
    expect(el.querySelector('[aria-label="Group"]')).toBeNull();
  });

  it('picks a private channel without changing who can see the room in Switch', async () => {
    const el = await render();
    await click(radio(el, 'New private channel')!);
    expect(latest.channel).toEqual({ kind: 'new', private: true });
    expect(latest.access).toBeNull();
  });

  it('takes an existing channel by its id', async () => {
    const el = await render();
    await click(radio(el, 'Existing channel')!);
    expect(el.querySelector('input[aria-label="Channel id"]')).not.toBeNull();
    expect(latest.channel).toEqual({ kind: 'existing', externalChannelId: '' });
  });

  it('offers no existing channel where the app cannot be pointed at one by id', async () => {
    const el = await render({ ...BRIDGE, channelIdsRefused: 'Add the app to the channel.' });
    expect(radio(el, 'Existing channel')).toBeUndefined();
  });

  it('opens More options on the group and access', async () => {
    const el = await render();
    await click(el.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    expect(el.querySelector('[aria-label="Group"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Access"]')).not.toBeNull();
  });

  it('offers the group only to a workspace admin, who alone puts rooms in groups', async () => {
    const el = await render(BRIDGE, false);
    expect(el.textContent).not.toContain('Group:');
    await click(el.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    expect(el.querySelector('[aria-label="Group"]')).toBeNull();
    expect(el.querySelector('[aria-label="Access"]')).not.toBeNull();
  });
});

describe('creating a Switch Console chat', () => {
  it('has no channel, and says the chat is private to those taking part until changed', async () => {
    const el = await render(null);
    expect(radio(el, 'New public channel')).toBeUndefined();
    expect(el.textContent).toContain('Group: none · Private');
    await click(el.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    expect(el.querySelector('[aria-label="Group"]')).not.toBeNull();
    expect(el.textContent).not.toContain('who can read or post in the channel');
    expect(latest.access).toBeNull();
  });
});
