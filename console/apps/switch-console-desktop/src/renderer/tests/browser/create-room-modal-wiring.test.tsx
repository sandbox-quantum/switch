/**
 * The New room dialog end to end, short of the server: what it sends for a
 * room on a messaging app, that an existing channel needs an id of its app's
 * shape before Create, that switching app starts the channel choice again,
 * that a Switch Console room is made as a chat, with the room's own settings
 * but no channel, and who is in a room on an app: the people known there,
 * carried between apps where they are the same person, and the creator of a
 * private channel.
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

const rpcMock = vi.hoisted(() => ({
  workspaces: {
    listBridges: vi.fn(),
    listAgents: vi.fn(async () => []),
    listRoomGroups: vi.fn(async () => []),
    listBridgePeople: vi.fn(async (_params: { bridgeId: string }): Promise<unknown[]> => []),
    listMyIdentities: vi.fn(async (): Promise<unknown[]> => []),
    createRoom: vi.fn(),
  },
  chats: {
    workspaceMembers: vi.fn(async (): Promise<unknown[]> => []),
    agentCandidates: vi.fn(async () => []),
    create: vi.fn(),
  },
}));

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: rpcMock }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ group_chats: true }),
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useManagedAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsInWorkspace: () => [] },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    activeServerId: 's1',
    servers: [{ id: 's1', name: 'Acme' }],
    statusFor: () => ({ connected: true, user: { id: 'u1' } }),
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    workspaces: [{ id: 'ws', tenantId: 't1' }],
    idOnServerInScope: (serverId: string | null) => (serverId ? 'ws' : null),
  },
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceById: () => true,
}));
vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: { add: vi.fn() } }));
vi.mock('@renderer/features/sidebar/sidebar-room-grouping', () => ({ openRoomView: vi.fn() }));
vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: vi.fn(async () => {}),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { setGrouping: vi.fn(), ensureRoomExpanded: vi.fn() },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));
// The dialog's frame needs an open dialog around it; its contents are the subject here.
vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Dialog: pass,
    DialogClose: pass,
    DialogContent: pass,
    DialogContentArea: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
  };
});
// The app pill is a menu; a plain select stands in for it, as the choice is what matters here.
vi.mock('@renderer/features/switch-servers/messaging-app-selector', () => ({
  SWITCH_CONSOLE: '',
  MessagingAppSelector: ({
    bridges,
    value,
    onChange,
  }: {
    bridges: { id: string; displayName: string }[];
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select aria-label="Messaging app" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Switch Console</option>
      {bridges.map((bridge) => (
        <option key={bridge.id} value={bridge.id}>
          {bridge.displayName}
        </option>
      ))}
    </select>
  ),
}));

import { CreateRoomModal } from '@renderer/features/switch-servers/CreateRoomModal';

const bridge = (id: string, type: string, displayName: string) => ({
  id,
  type,
  displayName,
  status: 'active',
  canCreateChannels: true,
  channelIdsRefused: null,
  privateChannels: null,
  privateChannelNeedsLinkedAccount: false,
  publicChannelAddsCreator: false,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  rpcMock.workspaces.listBridges.mockResolvedValue([
    bridge('b1', 'slack', 'Acme Slack'),
    bridge('b2', 'mattermost', 'switch-dev'),
  ]);
  rpcMock.workspaces.createRoom.mockResolvedValue({ kind: 'created', room: { id: 'r1' } });
  rpcMock.chats.create.mockResolvedValue({ roomId: 'r2' });
  rpcMock.chats.workspaceMembers.mockResolvedValue([]);
  rpcMock.workspaces.listBridgePeople.mockResolvedValue([]);
  rpcMock.workspaces.listMyIdentities.mockResolvedValue([]);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <CreateRoomModal onSuccess={() => {}} onClose={() => {}} />
      </QueryClientProvider>
    )
  );
  await act(async () => {});
  return container;
}

async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      text
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseApp(host: HTMLElement, value: string) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Messaging app"]')!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const card = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((each) =>
    each.textContent?.startsWith(title)
  )!;
const createButton = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].find((each) => each.textContent?.includes('Create room'))!;
const channelIdInput = (host: HTMLElement) =>
  host.querySelector<HTMLInputElement>('input[aria-label="Channel id"]');
const participants = (host: HTMLElement) =>
  host.querySelector<HTMLInputElement>('#new-room-participants')!;
const options = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="option"]')].map((each) => each.textContent ?? '');

async function pick(host: HTMLElement, query: string) {
  await act(async () => participants(host).focus());
  await typeInto(participants(host), query);
  const option = [...host.querySelectorAll<HTMLElement>('[role="option"]')][0]!;
  await act(async () => option.click());
}

const person = (
  username: string,
  linkedUserIds: string[] = [],
  linkedName: string | null = null
) => ({
  username,
  externalUserId: `ext-${username}`,
  linkedUserIds,
  linkedName,
});

describe('New room dialog', () => {
  it('holds Create until an existing channel has an id of its app’s shape, then sends it', async () => {
    const host = await render();
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-name')!, 'design-review');
    await chooseApp(host, 'b1');
    await act(async () => card(host, 'Existing channel').click());

    expect(createButton(host).disabled).toBe(true);
    await typeInto(channelIdInput(host)!, 'general');
    expect(createButton(host).disabled).toBe(true);
    expect(host.textContent).toContain('starts with C or G');

    // Pasted in lower case with space around it: taken as meant, and sent as Slack writes it.
    await typeInto(channelIdInput(host)!, ' c0123abcd ');
    expect(createButton(host).disabled).toBe(false);
    await act(async () => createButton(host).click());

    expect(rpcMock.workspaces.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeId: 'b1',
        name: 'design-review',
        channel: { kind: 'existing', externalChannelId: 'C0123ABCD' },
        groupId: null,
      })
    );
  });

  it('starts the channel choice again on another app, dropping a typed id', async () => {
    const host = await render();
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-name')!, 'design-review');
    await chooseApp(host, 'b1');
    await act(async () => card(host, 'Existing channel').click());
    await typeInto(channelIdInput(host)!, 'C0123ABCD');

    await chooseApp(host, 'b2');
    expect(channelIdInput(host)).toBeNull();
    expect(card(host, 'New public channel').getAttribute('aria-checked')).toBe('true');

    await act(async () => createButton(host).click());
    expect(rpcMock.workspaces.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'b2', channel: { kind: 'new', private: false } })
    );
  });

  it('makes a Switch Console room as a chat, leaving the app’s options behind', async () => {
    const host = await render();
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-name')!, 'design-review');
    await chooseApp(host, 'b1');
    await act(async () => card(host, 'New private channel').click());
    await chooseApp(host, '');

    await act(async () => createButton(host).click());
    expect(rpcMock.workspaces.createRoom).not.toHaveBeenCalled();
    expect(rpcMock.chats.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'design-review', kind: 'group' })
    );
    expect(rpcMock.chats.create.mock.calls[0][0]).not.toHaveProperty('channel');
  });

  it('makes a Switch Console chat with its description and instructions', async () => {
    const host = await render();
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-name')!, 'design-review');
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-description')!, ' Reviews ');
    const instructions = host.querySelector<HTMLTextAreaElement>('#new-room-instructions')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        instructions,
        'Be brief.'
      );
      instructions.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('More options');

    await act(async () => createButton(host).click());
    expect(rpcMock.chats.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'design-review',
        description: 'Reviews',
        instructions: 'Be brief.',
        groupId: null,
        access: null,
      })
    );
  });

  it('offers the people known on the app, and sends them by their username there', async () => {
    rpcMock.workspaces.listBridgePeople.mockResolvedValue([person('bob.s', ['u2'], 'Bob')]);
    const host = await render();
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-name')!, 'design-review');
    await chooseApp(host, 'b1');

    await pick(host, 'bob');
    await act(async () => createButton(host).click());

    expect(rpcMock.workspaces.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'b1', userNames: ['bob.s'] })
    );
  });

  it('shows the creator in a new private channel through their linked account', async () => {
    rpcMock.workspaces.listMyIdentities.mockResolvedValue([
      {
        id: 'x1',
        bridgeId: 'b1',
        externalUserId: 'ext-ada',
        externalUsername: 'ada',
        verified: true,
      },
    ]);
    rpcMock.workspaces.listBridgePeople.mockResolvedValue([
      person('ada', ['u1'], 'Ada'),
      person('bob.s', ['u2'], 'Bob'),
    ]);
    const host = await render();
    await chooseApp(host, 'b1');
    expect(host.textContent).not.toContain('@ada');

    await act(async () => card(host, 'New private channel').click());
    expect(host.textContent).toContain('You@ada');
    // Shown, so not offered as well.
    await act(async () => participants(host).focus());
    expect(options(host).some((each) => each.includes('@ada'))).toBe(false);
    expect(options(host).some((each) => each.includes('@bob.s'))).toBe(true);
  });

  it('marks the creator of a private channel who has no linked account, in their chip', async () => {
    const host = await render();
    await chooseApp(host, 'b1');
    await act(async () => card(host, 'New private channel').click());

    expect(host.textContent).toContain('YouNo linked Acme Slack account');
  });

  it('shows the creator in a new public channel where the app puts them in it', async () => {
    rpcMock.workspaces.listBridges.mockResolvedValue([
      { ...bridge('b1', 'slack', 'Acme Slack'), publicChannelAddsCreator: true },
    ]);
    rpcMock.workspaces.listMyIdentities.mockResolvedValue([
      {
        id: 'x1',
        bridgeId: 'b1',
        externalUserId: 'ext-ada',
        externalUsername: 'ada',
        verified: true,
      },
    ]);
    rpcMock.workspaces.listBridgePeople.mockResolvedValue([person('ada', ['u1'], 'Ada')]);
    const host = await render();
    await chooseApp(host, 'b1');

    expect(host.textContent).toContain('You@ada');
    await act(async () => participants(host).focus());
    expect(options(host).some((each) => each.includes('@ada'))).toBe(false);
  });

  it('shows nobody fixed in a new public channel without a linked account', async () => {
    rpcMock.workspaces.listBridges.mockResolvedValue([
      { ...bridge('b1', 'slack', 'Acme Slack'), publicChannelAddsCreator: true },
    ]);
    const host = await render();
    await chooseApp(host, 'b1');

    expect(host.textContent).not.toContain('You');
    expect(host.textContent).not.toContain('No linked');
  });

  it('shows nobody fixed in a new public channel where the app does not add them', async () => {
    rpcMock.workspaces.listMyIdentities.mockResolvedValue([
      {
        id: 'x1',
        bridgeId: 'b1',
        externalUserId: 'ext-ada',
        externalUsername: 'ada',
        verified: true,
      },
    ]);
    const host = await render();
    await chooseApp(host, 'b1');

    expect(host.textContent).not.toContain('You@ada');
  });

  it('carries a picked person to an app they are linked on, and names who is not', async () => {
    rpcMock.chats.workspaceMembers.mockResolvedValue([
      { userId: 'u2', name: 'Bob', email: 'bob@example.com', role: 'member' },
      { userId: 'u3', name: 'Carol', email: 'carol@example.com', role: 'member' },
    ]);
    rpcMock.workspaces.listBridgePeople.mockResolvedValue([person('bob.s', ['u2'], 'Bob')]);
    const host = await render();
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-name')!, 'design-review');
    await pick(host, 'Bob');
    await pick(host, 'Carol');

    await chooseApp(host, 'b1');
    expect(host.textContent).toContain('Not added: Carol.');

    await act(async () => createButton(host).click());
    expect(rpcMock.workspaces.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'b1', userNames: ['bob.s'] })
    );
  });

  it('keeps the latest app when an earlier switch finishes after it', async () => {
    rpcMock.chats.workspaceMembers.mockResolvedValue([
      { userId: 'u2', name: 'Bob', email: 'bob@example.com', role: 'member' },
    ]);
    let releaseSlack: (people: unknown[]) => void = () => {};
    rpcMock.workspaces.listBridgePeople.mockImplementation(
      async ({ bridgeId }: { bridgeId: string }) =>
        bridgeId === 'b1'
          ? new Promise<unknown[]>((resolve) => (releaseSlack = resolve))
          : [person('bob.m', ['u2'], 'Bob')]
    );
    const host = await render();
    await typeInto(host.querySelector<HTMLInputElement>('#new-room-name')!, 'design-review');
    await pick(host, 'Bob');

    await chooseApp(host, 'b1');
    expect(createButton(host).disabled).toBe(true);
    await chooseApp(host, 'b2');
    await act(async () => releaseSlack([person('bob.s', ['u2'], 'Bob')]));

    await act(async () => createButton(host).click());
    expect(rpcMock.workspaces.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'b2', userNames: ['bob.m'] })
    );
  });
});
