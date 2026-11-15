/**
 * The room's info names its owner when it has one, and leaves the row out
 * when it has none (a room an agent created) rather than showing a dash.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));

import { RoomInfoSection } from '@renderer/features/switch-rooms/room-settings-sections';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const room = (ownerName: string | null) =>
  ({
    createdAt: '2026-01-01T00:00:00Z',
    ownerName,
    bridgeDisplayName: 'Slack',
    isConsoleChat: false,
    linkedChannelName: 'bakery-orders',
    externalChannelId: null,
    transportRoomId: null,
  }) as RemoteRoomDetail;

async function labels(ownerName: string | null): Promise<string[]> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<RoomInfoSection room={room(ownerName)} />));
  return [...container.querySelectorAll('dt')].map((dt) => dt.textContent ?? '');
}

it('names the owner when the room has one', async () => {
  expect(await labels('Maya Baker')).toEqual(['Created', 'Owner', 'Messaging app', 'Channel']);
  expect(container!.textContent).toContain('Maya Baker');
});

it('leaves the owner out, not a dash, when the room has none', async () => {
  expect(await labels(null)).toEqual(['Created', 'Messaging app', 'Channel']);
  expect(container!.textContent).not.toContain('—');
});
