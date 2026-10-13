/**
 * Connecting a messaging app to a workspace.
 *
 * Where the server has its own app for a platform, the dialog leads with
 * installing it — the consent screen opens in the browser and the dialog
 * watches for the connection it creates — and keeps the paste-your-tokens
 * form one click away. Where it has none, the form is all there is.
 *
 * A claim-based app (Telegram) is offered alongside: its link and code are
 * shown here, and a workspace's first chat is watched for like an install.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listBridgeTypes = vi.hoisted(() => vi.fn());
const listMessagingApps = vi.hoisted(() => vi.fn());
const beginMessagingAppInstall = vi.hoisted(() => vi.fn());
const beginChatClaim = vi.hoisted(() => vi.fn());
const listBridges = vi.hoisted(() => vi.fn());
const createBridge = vi.hoisted(() => vi.fn());
const openExternalUrl = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspaces: {
      listBridgeTypes,
      listMessagingApps,
      beginMessagingAppInstall,
      beginChatClaim,
      listBridges,
      createBridge,
    },
  },
  events: { on: () => () => {}, emit: () => {} },
}));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws-1' },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 'srv-1', servers: [{ id: 'srv-1', name: 'Dev' }] },
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => true,
}));

import { ConnectMessagingAppModal } from '@renderer/features/switch-servers/ConnectMessagingAppModal';
import { Dialog } from '@renderer/lib/ui/dialog';

const onSuccess = vi.fn();
const onClose = vi.fn();

function bridge(id: string, type: string) {
  return {
    id,
    type,
    displayName: `${type} ${id}`,
    status: 'active',
    isDefault: false,
    homeUrl: null,
    channelCreationSupported: true,
    channelCreationEnabled: true,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  listBridgeTypes
    .mockReset()
    .mockResolvedValue([
      { key: 'slack', fields: [], channelCreationSupported: true, directorySearchSupported: true },
    ]);
  listMessagingApps.mockReset().mockResolvedValue({ installable: ['slack'], claimable: [] });
  beginMessagingAppInstall.mockReset().mockResolvedValue('https://slack.example/oauth?state=s');
  beginChatClaim.mockReset().mockResolvedValue({
    url: 'https://t.me/example_bot?startgroup=abc',
    code: 'abc',
    botHandle: '@example_bot',
  });
  listBridges.mockReset().mockResolvedValue([bridge('b-old', 'slack')]);
  createBridge.mockReset();
  openExternalUrl.mockReset().mockResolvedValue(true);
  onSuccess.mockReset();
  onClose.mockReset();
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
        <Dialog open onOpenChange={() => {}}>
          <ConnectMessagingAppModal onSuccess={onSuccess} onClose={onClose} onClosed={() => {}} />
        </Dialog>
      </QueryClientProvider>
    )
  );
  await settle();
  return document.body;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

function findButton(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label)
  );
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = findButton(el, label);
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

describe('the connect-messaging-app dialog', () => {
  it('leads with installing the server’s own app, with no token form', async () => {
    const el = await render();

    expect(findButton(el, 'Add to Slack')).toBeDefined();
    expect(el.textContent).not.toContain('Choose a platform');
    expect(findButton(el, 'Connect')).toBeUndefined();
  });

  it('opens the consent page and hands back the connection it creates', async () => {
    const el = await render();
    listBridges
      .mockResolvedValueOnce([bridge('b-old', 'slack')])
      .mockResolvedValue([bridge('b-old', 'slack'), bridge('b-new', 'slack')]);

    await act(async () => button(el, 'Add to Slack').click());
    await settle();

    expect(beginMessagingAppInstall).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      platform: 'slack',
    });
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://slack.example/oauth?state=s',
      'Could not open Slack'
    );
    expect(onSuccess).toHaveBeenCalledWith({
      bridgeId: 'b-new',
      displayName: 'slack b-new',
      directorySearchSupported: true,
    });
  });

  it('keeps waiting while only connections that already existed are listed', async () => {
    const el = await render();

    await act(async () => button(el, 'Add to Slack').click());
    await settle();

    expect(el.textContent).toContain('Waiting for Slack');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('stays put when the browser could not be opened', async () => {
    openExternalUrl.mockResolvedValue(false);
    const el = await render();

    await act(async () => button(el, 'Add to Slack').click());
    await settle();

    expect(el.textContent).not.toContain('Waiting for Slack');
    expect(findButton(el, 'Add to Slack')).toBeDefined();
  });

  it('says so when the install could not be started', async () => {
    beginMessagingAppInstall.mockRejectedValue(new Error('install refused'));
    const el = await render();

    await act(async () => button(el, 'Add to Slack').click());
    await settle();

    expect(el.textContent).toContain('Could not start adding Slack');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('offers the token form behind "use your own app"', async () => {
    const el = await render();

    await act(async () => button(el, 'Use your own app instead').click());
    await settle();

    expect(el.textContent).toContain('Choose a platform');
    expect(findButton(el, 'Add to Slack')).toBeUndefined();
  });

  it('shows only the token form when the server has no app of its own', async () => {
    listMessagingApps.mockResolvedValue({ installable: [], claimable: [] });
    const el = await render();

    expect(el.textContent).toContain('Choose a platform');
    expect(findButton(el, 'Add to Slack')).toBeUndefined();
  });

  it('falls back to the token form, and says why, when the check fails', async () => {
    listMessagingApps.mockRejectedValue(new Error('boom'));
    const el = await render();

    expect(el.textContent).toContain('Could not check which messaging apps');
    expect(el.textContent).toContain('Choose a platform');
  });
});

describe('connecting a Telegram chat from the dialog', () => {
  function telegram(connected: boolean, canAddChat = true) {
    return {
      installable: [],
      claimable: [{ platform: 'telegram', connected, canAddChat }],
    };
  }

  it('is offered for a claim-based app, with no token form', async () => {
    listMessagingApps.mockResolvedValue(telegram(false));
    const el = await render();

    expect(findButton(el, 'Add to Telegram')).toBeDefined();
    expect(el.textContent).not.toContain('Choose a platform');
  });

  it('is not offered when the server says this user may not add a chat', async () => {
    listMessagingApps.mockResolvedValue(telegram(false, false));
    const el = await render();

    expect(findButton(el, 'Add to Telegram')).toBeUndefined();
    expect(el.textContent).toContain('Choose a platform');
  });

  it('shows the link, bot handle and command, and hands back the first chat’s connection', async () => {
    listMessagingApps.mockResolvedValue(telegram(false));
    const el = await render();
    listBridges
      .mockResolvedValueOnce([bridge('b-old', 'slack')])
      .mockResolvedValue([bridge('b-old', 'slack'), bridge('b-tg', 'telegram')]);

    await act(async () => button(el, 'Add to Telegram').click());
    await settle();

    expect(beginChatClaim).toHaveBeenCalledWith({ workspaceId: 'ws-1', platform: 'telegram' });
    expect(el.textContent).toContain('@example_bot');
    expect(el.textContent).toContain('/connect abc');
    expect(el.textContent).toContain('work once, for ten minutes');
    expect(onSuccess).toHaveBeenCalledWith({
      bridgeId: 'b-tg',
      displayName: 'telegram b-tg',
      directorySearchSupported: true,
    });
  });

  it('leaves only that chat on screen once its link is shown', async () => {
    listMessagingApps.mockResolvedValue({
      installable: ['slack'],
      claimable: [{ platform: 'telegram', connected: true, canAddChat: true }],
    });
    const el = await render();
    expect(findButton(el, 'Add to Slack')).toBeDefined();

    await act(async () => button(el, 'Add to Telegram').click());
    await settle();

    expect(findButton(el, 'Add to Slack')).toBeUndefined();
    expect(findButton(el, 'Use your own app instead')).toBeUndefined();
    expect(el.textContent).toContain('Add to Telegram');
    expect(findButton(el, 'Close')).toBeDefined();
  });

  it('opens the group link in the browser', async () => {
    listMessagingApps.mockResolvedValue(telegram(true));
    const el = await render();

    await act(async () => button(el, 'Add to Telegram').click());
    await settle();
    await act(async () => button(el, 'Add to a Telegram group').click());

    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://t.me/example_bot?startgroup=abc',
      'Could not open Telegram'
    );
  });

  it('does not wait for a connection once the workspace has one', async () => {
    listMessagingApps.mockResolvedValue(telegram(true));
    const el = await render();

    await act(async () => button(el, 'Add to Telegram').click());
    await settle();

    expect(el.textContent).toContain('/connect abc');
    expect(listBridges).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('says so when the claim could not be started', async () => {
    listMessagingApps.mockResolvedValue(telegram(true));
    beginChatClaim.mockRejectedValue(new Error('claim refused'));
    const el = await render();

    await act(async () => button(el, 'Add to Telegram').click());
    await settle();

    expect(el.textContent).toContain('Could not start connecting a Telegram chat');
    expect(findButton(el, 'Add to Telegram')).toBeDefined();
  });
});
