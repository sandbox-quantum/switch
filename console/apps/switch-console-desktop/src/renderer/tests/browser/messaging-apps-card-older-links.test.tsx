/**
 * Requiring confirmation for a messaging app's older links (CHOO-3881).
 *
 * Links made before links had to be confirmed still count, though nobody
 * proved the account was theirs. A workspace admin can make them wait for a
 * code like new ones. The card offers that per app, only to an admin, only
 * where there is something to move — and never asks the admin-only route on
 * anyone else's behalf.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const listBridges = vi.hoisted(() => vi.fn());
const listMyIdentities = vi.hoisted(() => vi.fn());
const listMyPendingIdentities = vi.hoisted(() => vi.fn());
const listUnconfirmedLinks = vi.hoisted(() => vi.fn());
const ownsOwnerAddressedAgent = vi.hoisted(() => vi.fn());
const bridgeInstallState = vi.hoisted(() => vi.fn());
const showModal = vi.hoisted(() => vi.fn());
const isAdmin = vi.hoisted(() => ({ value: true }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspaces: {
      listBridges,
      listMyIdentities,
      listMyPendingIdentities,
      listUnconfirmedLinks,
      ownsOwnerAddressedAgent,
      bridgeInstallState,
    },
    featureFlags: { get: () => Promise.resolve({ flags: {} }) },
  },
  events: { on: () => () => {}, emit: () => {} },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => showModal(id, args),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws-1', serverIdFor: () => 'srv-1' },
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => isAdmin.value,
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], statusFor: () => null },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { refreshRoomState: () => Promise.resolve() },
}));
vi.mock('@renderer/features/switch-servers/bridge-platforms-loader', () => ({
  bridgeTypesQueryKey: (workspaceId: string | null) => ['bridge-types', workspaceId],
  fetchBridgeTypes: () => Promise.resolve([]),
}));

import { MessagingAppsCard } from '@renderer/features/switch-servers/MessagingAppsCard';
import type { RemoteBridge, UnconfirmedLink } from '@shared/core/switch-servers/switch-servers';

function bridge(id: string, displayName: string): RemoteBridge {
  return {
    id,
    type: 'slack',
    displayName,
    status: 'active',
    isDefault: false,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
    attention: null,
    teamPlacementSupported: false,
    channelIdsRefused: null,
    receivesWebhooks: false,
    webhookUrl: null,
  };
}

function link(n: number): UnconfirmedLink {
  return {
    id: `eu-${n}`,
    externalUserId: `U${n}`,
    externalUsername: `person${n}`,
    userId: `u${n}`,
    userName: `Person ${n}`,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of [
    listBridges,
    listMyIdentities,
    listMyPendingIdentities,
    listUnconfirmedLinks,
    ownsOwnerAddressedAgent,
    bridgeInstallState,
    showModal,
  ]) {
    mock.mockReset();
  }
  isAdmin.value = true;
  listBridges.mockResolvedValue([bridge('b-acme', 'Acme Slack'), bridge('b-other', 'Other')]);
  listMyIdentities.mockResolvedValue([]);
  listMyPendingIdentities.mockResolvedValue([]);
  ownsOwnerAddressedAgent.mockResolvedValue(false);
  bridgeInstallState.mockResolvedValue('unknown');
  listUnconfirmedLinks.mockImplementation(async ({ bridgeId }: { bridgeId: string }) =>
    bridgeId === 'b-acme' ? [link(1), link(2)] : []
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLDivElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <MessagingAppsCard serverId="srv-1" />
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
  return container;
}

/** The menu labels for the row of the app with this name. */
async function menuOf(el: HTMLElement, displayName: string): Promise<HTMLElement[]> {
  const trigger = el.querySelector<HTMLButtonElement>(
    `button[aria-label="${displayName} actions"]`
  );
  expect(trigger, `no row for ${displayName}`).not.toBeNull();
  await act(async () => trigger!.click());
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe('older links on the messaging apps card', () => {
  it('offers an admin to require confirming them, with the count', async () => {
    const el = await render();
    await vi.waitFor(() =>
      expect(listUnconfirmedLinks).toHaveBeenCalledWith({ workspaceId: 'ws-1', bridgeId: 'b-acme' })
    );

    const item = (await menuOf(el, 'Acme Slack')).find(
      (i) => i.textContent?.trim() === 'Require confirmation for older links (2)…'
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());

    expect(showModal).toHaveBeenCalledWith('requireLinkConfirmationModal', {
      workspaceId: 'ws-1',
      bridgeId: 'b-acme',
      bridgeDisplayName: 'Acme Slack',
    });
  });

  it('offers nothing on an app with no older links', async () => {
    const el = await render();
    await vi.waitFor(() =>
      expect(listUnconfirmedLinks).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        bridgeId: 'b-other',
      })
    );

    const labels = (await menuOf(el, 'Other')).map((i) => i.textContent?.trim() ?? '');
    expect(labels.some((l) => l.startsWith('Require confirmation'))).toBe(false);
  });

  it('never asks for them, nor offers it, to someone who is not an admin', async () => {
    isAdmin.value = false;
    const el = await render();

    const labels = (await menuOf(el, 'Acme Slack')).map((i) => i.textContent?.trim() ?? '');
    expect(labels.some((l) => l.startsWith('Require confirmation'))).toBe(false);
    expect(listUnconfirmedLinks).not.toHaveBeenCalled();
  });
});
