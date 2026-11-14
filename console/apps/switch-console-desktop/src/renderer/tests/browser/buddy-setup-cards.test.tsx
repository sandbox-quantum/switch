/**
 * Acceptance cases for switch-buddy's setup cards in its Welcome chat: each
 * case renders the cards against a mocked server, asserts what the person
 * sees, and saves a screenshot of it under the app's gitignored
 * `build/acceptance/buddy-onboarding/`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { RpcError } from '@shared/lib/ipc/rpc-error';

const listBridges = vi.hoisted(() => vi.fn());
const listMyIdentities = vi.hoisted(() => vi.fn());
const getRoomDetail = vi.hoisted(() => vi.fn());
const listAgents = vi.hoisted(() => vi.fn());
const listAgentRooms = vi.hoisted(() => vi.fn());
const listRooms = vi.hoisted(() => vi.fn());
const followConsoleLink = vi.hoisted(() => vi.fn());
const createChat = vi.hoisted(() => vi.fn());
const openRoomChannel = vi.hoisted(() => vi.fn());
const shown = vi.hoisted(
  () => [] as { id: string; args: { onClosed?: () => void; bridgeId?: string } }[]
);
const listBridgeTypes = vi.hoisted(() => vi.fn());
const listMessagingApps = vi.hoisted(() => vi.fn());
const administersWorkspaceInScope = vi.hoisted(() => vi.fn());
const timeline = vi.hoisted(() => ({
  messages: [] as { sender: { kind: string }; body: string }[],
  pending: [] as { body: string }[],
  send: () => {},
}));

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
      listBridges,
      listMyIdentities,
      getRoomDetail,
      listAgents,
      listAgentRooms,
      listRooms,
      listBridgeTypes,
      listMessagingApps,
    },
    chats: { create: createChat },
    switchRooms: { openRoomChannel },
  },
  events: { on: () => () => {}, emit: () => {} },
}));
vi.mock('@renderer/lib/modal/modal-provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShowModal: (id: string) => (args: { onClosed?: () => void; bridgeId?: string }) =>
    shown.push({ id, args }),
}));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: {
    userId: 'user-ada',
    chat: (roomId: string) => ({ roomId, name: 'Welcome', bridgeType: null }),
    timelines: { get: () => timeline },
    add: () => {},
  },
  chatTitler: { created: () => {} },
}));
vi.mock('@renderer/features/deeplinks/console-link-handler', () => ({ followConsoleLink }));
vi.mock('@switch-console/chat-ui/components/chat-composer', () => ({
  focusComposerWhenOpened: () => {},
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    statusFor: () => ({ user: { name: 'Ada Lovelace', email: null } }),
    activeServerId: 'srv-1',
    servers: [{ id: 'srv-1', name: 'Dev' }],
  },
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope,
}));

import { BuddySetupCards } from '@renderer/features/switch-buddy/buddy-setup-cards';
import { ConnectMessagingAppModal } from '@renderer/features/switch-servers/ConnectMessagingAppModal';
import { appState } from '@renderer/lib/stores/app-state';
import { Dialog } from '@renderer/lib/ui/dialog';
import '@renderer/index.css';

/** Relative to this file; it must stay inside the workspace for Vite to write it. */
const SHOTS = '../../../../build/acceptance/buddy-onboarding';

function bridge(id: string, type: string, displayName: string): RemoteBridge {
  return {
    id,
    type,
    displayName,
    status: 'active',
    isDefault: false,
    homeUrl: null,
  } as RemoteBridge;
}

const acme = bridge('b-1', 'slack', 'Acme Slack');
const globex = bridge('b-2', 'slack', 'Globex Slack');
const teams = bridge('b-3', 'teams', 'Acme Teams');
const telegram = bridge('b-4', 'telegram', 'example_bot');
const discord = bridge('b-5', 'discord', 'Acme Discord');
const linked = (bridgeId: string) => ({ bridgeId }) as LinkedIdentity;

const noSuchOperation = () =>
  new RpcError({
    __switchConsoleRpcError: true,
    code: 'ChatApiError',
    message: 'No such operation',
    data: { apiCode: 'NO_SUCH_OPERATION' },
  });

const refused = (apiCode: string, message: string) =>
  new RpcError({
    __switchConsoleRpcError: true,
    code: 'ChatApiError',
    message,
    data: { apiCode },
  });

function slackChat(bridgeId: string) {
  return {
    roomId: `room-${bridgeId}`,
    name: null,
    channelType: 'direct',
    bridgeType: 'slack',
    agents: [{ id: 'agent-1' }],
  };
}

/** Bridges whose hand-off the server has made; a resume finds only those. */
let made: Set<string>;

type CreateParams = { bridgeId?: string; requestId: string; resumeOnly?: boolean };
const handoffCalls = () =>
  createChat.mock.calls.map(([params]) => params as CreateParams).filter((p) => !p.resumeOnly);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(async () => {
  made = new Set();
  listBridges.mockReset().mockResolvedValue([]);
  listMyIdentities.mockReset().mockResolvedValue([]);
  getRoomDetail.mockReset().mockResolvedValue({
    linkedChannelName: '#buddy-ada',
    externalChannelUrl: 'https://slack.example/archives/C123',
  });
  createChat.mockReset().mockImplementation(async (params: CreateParams) => {
    if (params.resumeOnly) {
      if (made.has(params.bridgeId!)) return slackChat(params.bridgeId!);
      throw noSuchOperation();
    }
    made.add(params.bridgeId!);
    return slackChat(params.bridgeId!);
  });
  openRoomChannel.mockReset().mockResolvedValue(undefined);
  listAgents.mockReset().mockResolvedValue([]);
  listAgentRooms.mockReset().mockResolvedValue([]);
  listRooms.mockReset().mockResolvedValue([]);
  followConsoleLink.mockReset();
  listBridgeTypes
    .mockReset()
    .mockResolvedValue([
      { key: 'slack', fields: [], channelCreationSupported: true, directorySearchSupported: true },
    ]);
  listMessagingApps.mockReset().mockResolvedValue({ installable: ['slack'], claimable: [] });
  administersWorkspaceInScope.mockReset().mockReturnValue(true);
  shown.length = 0;
  timeline.messages = [];
  timeline.pending = [];
  await page.viewport(760, 900);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  container.style.width = '720px';
  container.style.padding = '16px';
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <BuddySetupCards
          serverId="srv-1"
          workspaceId="ws-1"
          agentId="agent-1"
          agentName="switch-buddy"
          roomId="room-welcome"
        />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
}

async function shot(el: HTMLElement, name: string): Promise<void> {
  // Screenshots catch the settled look, not a button mid-transition.
  for (const node of el.querySelectorAll<HTMLElement>('*')) node.style.transition = 'none';
  await page.screenshot({ path: `${SHOTS}/${name}.png`, element: el });
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

async function click(el: HTMLElement, label: string): Promise<void> {
  await act(async () => button(el, label).click());
  await settle();
}

describe('switch-buddy setup cards', () => {
  it('(a) fresh install: asks where the team chats, then offers to connect the app picked', async () => {
    const el = await render();
    expect(el.textContent).toContain('Where does your team chat?');
    expect(findButton(el, 'Connect Slack')).toBeUndefined();
    await shot(el, 'a-fresh-install-choose');

    await click(el, 'Channels & DMs');

    expect(el.textContent).toContain('Add Slack to your Switch workspace.');
    expect(findButton(el, 'Connect Slack')).toBeDefined();
    await shot(el, 'a-fresh-install-connect');
  });

  it('(b) already connected and linked: offers the private channel', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    const el = await render();

    expect(el.textContent).toContain('Slack connected · account linked');
    expect(el.textContent).toContain('Continue in a private Slack channel');
    expect(findButton(el, 'Create channel and continue')).toBeDefined();
    expect(el.textContent).not.toContain('Which workspace?');
    await shot(el, 'b-connected-linked-create');
  });

  it('(b) a hand-off already made: done, with a link to the channel', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    made.add('b-1');
    const el = await render();

    expect(el.textContent).toContain('#buddy-ada ready');
    await click(el, 'Open Slack');
    expect(openRoomChannel).toHaveBeenCalledWith({
      serverId: 'srv-1',
      channelUrl: 'https://slack.example/archives/C123',
    });
    expect(handoffCalls()).toHaveLength(0);
    await shot(el, 'b-done-with-channel-link');
  });

  it('(b) after the hand-off: names the agents made since and their rooms, linked here', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    made.add('b-1');
    getRoomDetail.mockResolvedValue({
      linkedChannelName: '#buddy-ada',
      externalChannelUrl: 'https://slack.example/archives/C123',
      createdAt: '2026-01-01T10:00:00Z',
    });
    const agent = (id: string, name: string, ownerId: string, createdAt: string) => ({
      id,
      name,
      displayName: null,
      ownerId,
      createdAt,
    });
    listAgents.mockResolvedValue([
      agent('agent-1', 'switch-buddy', 'user-ada', '2026-01-01T09:00:00Z'),
      agent('agent-old', 'old-helper', 'user-ada', '2026-01-01T09:30:00Z'),
      agent('agent-other', 'someone-elses', 'user-bob', '2026-01-01T11:00:00Z'),
      {
        ...agent('agent-op', 'order-planner', 'user-ada', '2026-01-01T11:00:00Z'),
        displayName: 'Order Planner',
      },
    ]);
    listAgentRooms.mockImplementation(async ({ agentId }: { agentId: string }) =>
      agentId === 'agent-op'
        ? [
            { roomId: 'room-bakery', roomName: 'bakery-orders', archived: false },
            { roomId: 'room-gone', roomName: 'old-room', archived: true },
            { roomId: 'room-default', roomName: 'Town Square', archived: false },
          ]
        : []
    );
    // A bridge's default channel the agent joined is older than the hand-off: not named.
    listRooms.mockResolvedValue([
      { id: 'room-bakery', createdAt: '2026-01-01T11:30:00Z' },
      { id: 'room-gone', createdAt: '2026-01-01T11:30:00Z' },
      { id: 'room-default', createdAt: '2025-12-01T00:00:00Z' },
    ]);
    const el = await render();

    const summary = el.querySelector<HTMLElement>('[data-testid="buddy-created-since"]')!;
    expect(summary.textContent).toBe('Created since: Order Planner · bakery-orders room');
    expect(listAgentRooms).toHaveBeenCalledTimes(1);
    await click(summary, 'Order Planner');
    expect(followConsoleLink).toHaveBeenLastCalledWith('switchdash://open/agent/agent-op');
    await click(summary, 'bakery-orders');
    expect(followConsoleLink).toHaveBeenLastCalledWith('switchdash://open/room/room-bakery');
    await shot(el, 'x-handoff-summary');
  });

  it('(b) after the hand-off with nothing made since: no summary', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    made.add('b-1');
    getRoomDetail.mockResolvedValue({
      linkedChannelName: '#buddy-ada',
      externalChannelUrl: 'https://slack.example/archives/C123',
      createdAt: '2026-01-01T10:00:00Z',
    });
    listAgents.mockResolvedValue([
      {
        id: 'agent-1',
        name: 'switch-buddy',
        displayName: null,
        ownerId: 'user-ada',
        createdAt: '2026-01-01T09:00:00Z',
      },
    ]);
    const el = await render();

    expect(el.textContent).toContain('#buddy-ada ready');
    expect(el.querySelector('[data-testid="buddy-created-since"]')).toBeNull();
    expect(el.textContent).not.toContain('Created since');
  });

  it('(c) linking skipped: the link card, with staying in Console still offered', async () => {
    listBridges.mockResolvedValue([acme]);
    const el = await render();

    expect(el.textContent).toContain('Slack connected');
    expect(el.textContent).toContain('Link your Slack account');
    expect(findButton(el, 'Link account')).toBeDefined();
    expect(findButton(el, 'Continue here in Switch Console')).toBeDefined();
    await shot(el, 'c-linking-skipped');
  });

  it('(d) non-admin: the connect dialog explains admin rights are needed', async () => {
    administersWorkspaceInScope.mockReturnValue(false);
    const modalContainer = document.createElement('div');
    document.body.appendChild(modalContainer);
    const modalRoot = createRoot(modalContainer);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    await act(async () =>
      modalRoot.render(
        <QueryClientProvider client={client}>
          <Dialog open onOpenChange={() => {}}>
            <ConnectMessagingAppModal onSuccess={() => {}} onClose={() => {}} onClosed={() => {}} />
          </Dialog>
        </QueryClientProvider>
      )
    );
    await settle();

    const dialog = document.body;
    expect(dialog.textContent).toContain('Connect a messaging app to Dev');
    expect(dialog.textContent).toContain(
      'Connecting a messaging app requires an admin of this workspace.'
    );
    const dialogEl = document.querySelector('[role="dialog"]') || modalContainer;
    await shot(dialogEl as HTMLElement, 'd-non-admin-connect');

    await act(async () => modalRoot.unmount());
    modalContainer.remove();
  });

  it('(e) channel creation disabled: says why, and offers Try again', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    createChat.mockImplementation(async (params: CreateParams) => {
      if (params.resumeOnly) throw noSuchOperation();
      throw new Error('Channel creation is disabled for this workspace.');
    });
    const el = await render();

    await click(el, 'Create channel and continue');

    expect(el.textContent).toContain('Channel creation is disabled for this workspace.');
    expect(findButton(el, 'Try again')).toBeDefined();
    await shot(el, 'e-channel-creation-disabled');
  });

  it('(f) install cancelled: the connect card says it is not connected yet', async () => {
    const el = await render();
    await click(el, 'Channels & DMs');
    expect(el.textContent).not.toContain('isn’t connected yet');

    await click(el, 'Connect Slack');
    await act(async () => shown[0].args.onClosed!());
    await settle();

    expect(el.textContent).toContain('Slack isn’t connected yet. Try again when you’re ready.');
    expect(findButton(el, 'Connect Slack')).toBeDefined();
    await shot(el, 'f-install-cancelled');
  });

  it('(f) a connection made in the dialog moves on, with no note', async () => {
    const el = await render();
    await click(el, 'Channels & DMs');
    await click(el, 'Connect Slack');
    listBridges.mockResolvedValue([acme]);

    await act(async () => shown[0].args.onClosed!());
    await settle();

    expect(el.textContent).not.toContain('isn’t connected yet');
    expect(el.textContent).toContain('Link your Slack account');
  });

  it('(g) double Continue: one hand-off, the button busy meanwhile', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    let finish!: () => void;
    createChat.mockImplementation((params: CreateParams) => {
      if (params.resumeOnly) {
        return made.has(params.bridgeId!)
          ? Promise.resolve(slackChat(params.bridgeId!))
          : Promise.reject(noSuchOperation());
      }
      return new Promise((resolve) => {
        finish = () => {
          made.add(params.bridgeId!);
          resolve(slackChat(params.bridgeId!));
        };
      });
    });
    const el = await render();

    const continueButton = button(el, 'Create channel and continue');
    await act(async () => {
      continueButton.click();
      continueButton.click();
    });
    await settle();
    await act(async () => button(el, 'Creating channel…').click());
    await settle();

    expect(handoffCalls()).toHaveLength(1);
    expect(button(el, 'Creating channel…').disabled).toBe(true);
    await shot(el, 'g-double-continue');

    await act(async () => finish());
    await settle();
    expect(el.textContent).toContain('#buddy-ada ready');
    expect(handoffCalls()).toHaveLength(1);
  });

  it('(h) several linked workspaces: asks which, and hands off on the one chosen', async () => {
    listBridges.mockResolvedValue([acme, globex]);
    listMyIdentities.mockResolvedValue([linked('b-1'), linked('b-2')]);
    const el = await render();

    expect(el.textContent).toContain('Which workspace?');
    expect(button(el, 'Acme Slack').getAttribute('aria-pressed')).toBe('true');
    await click(el, 'Globex Slack');
    expect(button(el, 'Globex Slack').getAttribute('aria-pressed')).toBe('true');
    expect(button(el, 'Acme Slack').getAttribute('aria-pressed')).toBe('false');
    await shot(el, 'h-multiple-workspaces');

    await click(el, 'Create channel and continue');

    expect(handoffCalls()).toEqual([
      expect.objectContaining({ bridgeId: 'b-2', requestId: 'buddy-handoff:agent-1:b-2' }),
    ]);
    expect(el.textContent).toContain('#buddy-ada ready');
    expect(getRoomDetail).toHaveBeenCalledWith({ workspaceId: 'ws-1', roomId: 'room-b-2' });
  });

  it('(h) several workspaces, none linked: links the one chosen, then hands off there', async () => {
    listBridges.mockResolvedValue([acme, globex]);
    const el = await render();

    expect(el.textContent).toContain('Which workspace?');
    expect(button(el, 'Acme Slack').getAttribute('aria-pressed')).toBe('true');
    await click(el, 'Globex Slack');
    expect(button(el, 'Globex Slack').getAttribute('aria-pressed')).toBe('true');
    expect(el.textContent).toContain('So I recognise you in Globex Slack.');
    await shot(el, 'h2-choose-workspace-before-link');

    await click(el, 'Link account');
    expect(shown.at(-1)).toMatchObject({ id: 'claimIdentityModal', args: { bridgeId: 'b-2' } });

    listMyIdentities.mockResolvedValue([linked('b-2')]);
    await act(async () => client.invalidateQueries({ queryKey: ['my-switch-identities', 'ws-1'] }));
    await settle();
    await click(el, 'Create channel and continue');

    expect(handoffCalls()).toEqual([expect.objectContaining({ bridgeId: 'b-2' })]);
  });

  it('(h) a choice made before linking stays chosen once both are linked', async () => {
    listBridges.mockResolvedValue([acme, globex]);
    const el = await render();
    await click(el, 'Globex Slack');

    listMyIdentities.mockResolvedValue([linked('b-1'), linked('b-2')]);
    await act(async () => client.invalidateQueries({ queryKey: ['my-switch-identities', 'ws-1'] }));
    await settle();

    expect(button(el, 'Globex Slack').getAttribute('aria-pressed')).toBe('true');
    await click(el, 'Create channel and continue');
    expect(handoffCalls()).toEqual([expect.objectContaining({ bridgeId: 'b-2' })]);
  });

  for (const { platform, unit, a, b } of [
    { platform: 'slack', unit: 'workspace', a: acme, b: globex },
    {
      platform: 'discord',
      unit: 'server',
      a: discord,
      b: bridge('b-6', 'discord', 'Globex Discord'),
    },
  ]) {
    it(`(h) ${platform}: one linked and one not, both are choices, each in its own state`, async () => {
      listBridges.mockResolvedValue([a, b]);
      listMyIdentities.mockResolvedValue([linked(a.id)]);
      const el = await render();

      expect(el.textContent).toContain(`Which ${unit}?`);
      expect(button(el, a.displayName).getAttribute('aria-pressed')).toBe('true');
      expect(findButton(el, b.displayName)).toBeDefined();
      expect(findButton(el, 'Create channel and continue')).toBeDefined();

      await click(el, b.displayName);
      expect(button(el, b.displayName).getAttribute('aria-pressed')).toBe('true');
      expect(el.textContent).toContain(`So I recognise you in ${b.displayName}.`);
      expect(findButton(el, 'Create channel and continue')).toBeUndefined();
      await shot(el, `h3-mixed-${platform}`);
      await click(el, 'Link account');
      expect(shown.at(-1)).toMatchObject({ id: 'claimIdentityModal', args: { bridgeId: b.id } });

      await click(el, a.displayName);
      expect(findButton(el, 'Link account')).toBeUndefined();
      await click(el, 'Create channel and continue');
      expect(handoffCalls()).toEqual([expect.objectContaining({ bridgeId: a.id })]);
    });
  }

  it('(i) invite or post failure: Try again, then done', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    createChat.mockImplementationOnce(async () => {
      throw noSuchOperation();
    });
    createChat.mockImplementationOnce(async () => {
      throw new Error('Could not invite switch-buddy to the channel.');
    });
    const el = await render();

    await click(el, 'Create channel and continue');
    expect(el.textContent).toContain('Could not invite switch-buddy to the channel.');
    await shot(el, 'i-invite-failure');

    await click(el, 'Try again');

    expect(el.textContent).toContain('#buddy-ada ready');
    expect(findButton(el, 'Open Slack')).toBeDefined();
    await shot(el, 'i-retry-done');
  });

  it('(k) Console only: setup cards are hidden after staying', async () => {
    timeline.messages = [
      { sender: { kind: 'human' }, body: 'I’ll stay in Switch Console for now.' },
    ];
    const el = await render();

    expect(el.querySelector('[data-testid="buddy-setup-cards"]')).toBeNull();
    await shot(el, 'k-console-only');
  });

  it('(l) done without a channel link: says to find it in Slack', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    getRoomDetail.mockResolvedValue({ linkedChannelName: null, externalChannelUrl: null });
    made.add('b-1');
    const el = await render();

    expect(el.textContent).toContain('Private Slack channel ready');
    expect(el.textContent).toContain('Couldn’t get a link to the Slack channel. Find it in Slack.');
    expect(findButton(el, 'Open Slack')).toBeUndefined();
    await shot(el, 'x-done-without-link');
  });

  it('(m) Teams linked: guides adding the app and inviting the buddy', async () => {
    listBridges.mockResolvedValue([teams]);
    listMyIdentities.mockResolvedValue([linked('b-3')]);
    const el = await render();

    expect(el.textContent).toContain('Continue in Microsoft Teams');
    expect(el.textContent).toContain('!invite-agent @switch-buddy');
    expect(el.textContent).toContain(
      'Then mention switch-buddy with a short note on what you work on.'
    );
    expect(el.textContent).not.toContain('I’ll answer');
    await shot(el, 'x-teams-guide');
  });

  it('(n) Telegram linked: guides inviting the buddy in the group', async () => {
    listBridges.mockResolvedValue([telegram]);
    listMyIdentities.mockResolvedValue([linked('b-4')]);
    const el = await render();

    expect(el.textContent).toContain('Continue in Telegram');
    expect(el.textContent).toContain('/invite_agent @switch-buddy');
    expect(el.textContent).toContain("reply to the bot's message");
    expect(el.textContent).toContain('mention switch-buddy in that reply');
    expect(el.textContent).not.toContain('I’ll answer');
    await shot(el, 'x-telegram-guide');
  });

  it('(o) Discord linked: continues in a private Discord channel, then opens it', async () => {
    listBridges.mockResolvedValue([discord]);
    listMyIdentities.mockResolvedValue([linked('b-5')]);
    getRoomDetail.mockResolvedValue({
      linkedChannelName: '#dm-ada-switch-buddy',
      externalChannelUrl: 'https://discord.com/channels/1/2',
    });
    const el = await render();

    expect(el.textContent).toContain('Discord connected · account linked');
    expect(el.textContent).toContain('Continue in a private Discord channel');
    await shot(el, 'x-discord-create');

    await click(el, 'Create channel and continue');

    expect(handoffCalls()).toEqual([
      expect.objectContaining({ bridgeId: 'b-5', requestId: 'buddy-handoff:agent-1:b-5' }),
    ]);
    expect(el.textContent).toContain('#dm-ada-switch-buddy ready');
    await click(el, 'Open Discord');
    expect(openRoomChannel).toHaveBeenCalledWith({
      serverId: 'srv-1',
      channelUrl: 'https://discord.com/channels/1/2',
    });
    await shot(el, 'x-discord-done');
  });

  it('(o) Slack and Discord linked, handed off on Discord: waits for both before offering a channel', async () => {
    listBridges.mockResolvedValue([acme, discord]);
    listMyIdentities.mockResolvedValue([linked('b-1'), linked('b-5')]);
    let answerDiscord: (chat: ReturnType<typeof slackChat>) => void = () => {};
    createChat.mockImplementation((params: CreateParams) => {
      if (params.bridgeId === 'b-5')
        return new Promise((resolve) => {
          answerDiscord = resolve;
        });
      return Promise.reject(noSuchOperation());
    });
    getRoomDetail.mockResolvedValue({
      linkedChannelName: '#dm-ada-switch-buddy',
      externalChannelUrl: 'https://discord.com/channels/1/2',
    });
    const el = await render();

    expect(el.textContent).toContain('Finishing setup');
    expect(el.textContent).not.toContain('Continue in a private');
    expect(findButton(el, 'Create channel and continue')).toBeUndefined();

    await act(async () => answerDiscord({ ...slackChat('b-5'), bridgeType: 'discord' }));
    await settle();

    expect(el.textContent).toContain('#dm-ada-switch-buddy ready');
    expect(findButton(el, 'Open Discord')).toBeDefined();
    expect(handoffCalls()).toHaveLength(0);
  });

  it('(p) an auto-selected Slack whose resume read fails: says so, and Retry reads it again', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([linked('b-1')]);
    createChat.mockImplementationOnce(async () => {
      throw new Error('down');
    });
    const el = await render();

    expect(el.textContent).toContain('Couldn’t check Slack');
    await shot(el, 'x-auto-check-failed');
    await click(el, 'Retry');

    expect(createChat).toHaveBeenCalledTimes(2);
    expect(el.textContent).not.toContain('Couldn’t check');
    expect(findButton(el, 'Create channel and continue')).toBeDefined();
  });

  it('(q) a failed first read of the chat apps: says so, and Retry reads them again', async () => {
    listBridges.mockReset().mockRejectedValueOnce(new Error('down')).mockResolvedValue([]);
    const el = await render();

    expect(el.textContent).toContain('Couldn’t check your chat apps');
    await shot(el, 'x-apps-check-failed');
    await click(el, 'Retry');

    expect(listBridges).toHaveBeenCalledTimes(2);
    expect(el.textContent).not.toContain('Couldn’t check');
  });

  it('(r) more than one account linked: the server reason, unlink guidance, and Retry', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([
      { bridgeId: 'b-1', externalUserId: 'U1' } as LinkedIdentity,
      { bridgeId: 'b-1', externalUserId: 'U9' } as LinkedIdentity,
    ]);
    const reason =
      'Your Switch account is linked to 2 accounts on Acme Slack. Unlink the ones you no longer use in your Switch settings, then try again.';
    createChat.mockImplementation(async (params: CreateParams) => {
      if (params.resumeOnly) throw noSuchOperation();
      throw refused('ACCOUNTS_AMBIGUOUS', reason);
    });
    const navigate = vi.spyOn(appState.navigation, 'navigate').mockImplementation(() => {});
    const el = await render();

    await click(el, 'Create channel and continue');

    expect(el.textContent).toContain(reason);
    expect(el.textContent).toContain('Unlink the Slack account you no longer use, then retry.');
    expect(findButton(el, 'Start again')).toBeUndefined();
    await shot(el, 'x-accounts-ambiguous');
    await click(el, 'Manage linked accounts');
    expect(navigate).toHaveBeenCalledWith('settings', { tab: 'messaging-apps' });
    navigate.mockRestore();

    await click(el, 'Retry');
    expect(findButton(el, 'Create channel and continue')).toBeDefined();
  });

  it('(s) linked account changed: the server reason, and a fresh hand-off for the new account', async () => {
    listBridges.mockResolvedValue([acme]);
    listMyIdentities.mockResolvedValue([
      { bridgeId: 'b-1', externalUserId: 'U2' } as LinkedIdentity,
    ]);
    const reason =
      'This chat was started with a different linked account than the one now linked. Start a new chat.';
    const restartId = 'buddy-handoff:agent-1:b-1:U2';
    let finish!: () => void;
    createChat.mockImplementation((params: CreateParams) => {
      if (params.resumeOnly) {
        if (params.requestId === 'buddy-handoff:agent-1:b-1')
          return Promise.reject(refused('LINKED_ACCOUNT_CHANGED', reason));
        return made.has(params.requestId)
          ? Promise.resolve(slackChat('b-1'))
          : Promise.reject(noSuchOperation());
      }
      return new Promise((resolve) => {
        finish = () => {
          made.add(params.requestId);
          resolve(slackChat('b-1'));
        };
      });
    });
    const el = await render();

    expect(el.textContent).toContain(reason);
    expect(findButton(el, 'Retry')).toBeUndefined();
    await shot(el, 'x-account-changed');

    const restart = button(el, 'Start again with your new account');
    await act(async () => {
      restart.click();
      restart.click();
    });
    await settle();
    expect(button(el, 'Creating channel…').disabled).toBe(true);
    await act(async () => finish());
    await settle();

    expect(handoffCalls()).toHaveLength(1);
    expect(handoffCalls()[0]).toMatchObject({ bridgeId: 'b-1', requestId: restartId });
    expect(el.textContent).toContain('#buddy-ada ready');
  });
});
