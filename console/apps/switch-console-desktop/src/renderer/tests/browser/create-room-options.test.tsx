/**
 * The New room dialog's More options for a room on a messaging app: shut at
 * first, each choice starting where the server would leave it, and binding an
 * existing channel only where the app allows it.
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

import { CreateRoomOptions } from '@renderer/features/switch-servers/create-room-options';
import {
  DEFAULT_ROOM_OPTIONS,
  type RoomCreateOptions,
} from '@renderer/features/switch-servers/room-create-request';

const BRIDGE = { id: 'b1', displayName: 'Acme Slack', channelIdsRefused: null } as RemoteBridge;

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

function Harness({ bridge }: { bridge: RemoteBridge }) {
  const [value, setValue] = useState<RoomCreateOptions>(DEFAULT_ROOM_OPTIONS);
  return (
    <CreateRoomOptions
      workspaceId="ws-1"
      bridge={bridge}
      value={value}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
    />
  );
}

async function render(bridge: RemoteBridge = BRIDGE): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Harness bridge={bridge} />
      </QueryClientProvider>
    )
  );
  return container;
}

function button(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text
  );
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

describe('More options when creating a room on a messaging app', () => {
  it('starts shut, and opens on a new public channel open to the workspace', async () => {
    const el = await render();
    expect(el.textContent).not.toContain('Channel in Acme Slack');
    await click(button(el, 'More options')!);
    expect(el.textContent).toContain('Channel in Acme Slack');
    expect(el.textContent).toContain('A public channel in Acme Slack');
    expect(el.textContent).toContain('Everyone in the workspace can see and change it');
  });

  it('asks for a private channel without changing who can see the room in Switch', async () => {
    const el = await render();
    await click(button(el, 'More options')!);
    await click(button(el, 'New private')!);
    expect(latest.channel).toEqual({ kind: 'new', private: true });
    expect(latest.access).toBeNull();
    expect(el.textContent).toContain('only people added to it can see it');
  });

  it('takes an existing channel by its id', async () => {
    const el = await render();
    await click(button(el, 'More options')!);
    await click(button(el, 'Existing')!);
    expect(el.querySelector('input[aria-label="Channel id"]')).not.toBeNull();
    expect(latest.channel).toEqual({ kind: 'existing', externalChannelId: '' });
  });

  it('offers no existing channel where the app cannot be pointed at one by id', async () => {
    const el = await render({ ...BRIDGE, channelIdsRefused: 'Add the app to the channel.' });
    await click(button(el, 'More options')!);
    expect(button(el, 'Existing')).toBeUndefined();
  });
});
