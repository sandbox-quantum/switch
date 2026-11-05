/**
 * The Library: the workspace's references and documents as cards, with an
 * item's own page to change it and attach it to rooms. What is offered follows
 * the server's rule — the owner and admins change and delete, anyone changes
 * an open item.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem } from '@shared/core/switch-servers/library';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  items: { references: [] as unknown[], documents: [] as unknown[] },
  item: null as unknown,
  rooms: [] as { roomId: string; roomName: string }[],
  admin: false,
}));
const rpcMock = vi.hoisted(() => ({
  listLibraryItems: vi.fn(),
  getLibraryItem: vi.fn(),
  updateLibraryItem: vi.fn(),
  listLibraryItemRooms: vi.fn(),
  listReferenceTypes: vi.fn(),
  listLibrary: vi.fn(),
  setRoomResourceAttached: vi.fn(),
}));
const showModal = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces: rpcMock },
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: state.params }),
  useNavigate: () => ({ navigate }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => showModal(id, args),
  showModal: vi.fn(),
}));
vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
vi.mock('@renderer/features/switch-rooms/open-room', () => ({ openRoom: async () => {} }));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws', serverIdFor: () => 'srv', activeId: 'ws' },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    servers: [{ id: 'srv', name: 'Server', managed: false }],
    statusFor: () => ({ connected: true, user: { id: 'me' } }),
  },
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => state.admin,
}));
vi.mock('@renderer/features/switch-servers/use-listed-rooms', () => ({
  useReadableRoomsInWorkspace: () => [
    { id: 'room-1', name: 'design', description: '', archived: false, ownerId: 'me' },
    { id: 'room-2', name: 'support', description: '', archived: false, ownerId: 'me' },
  ],
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomPermissions: () => ({ canWrite: true, canManage: true, canUnlink: true }),
  },
}));

import { libraryItemView } from '@renderer/features/library/library-item-view';
import { DeleteLibraryItemModal } from '@renderer/features/library/library-modals';
import { libraryView } from '@renderer/features/library/library-view';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

function item(over: Partial<LibraryItem>): LibraryItem {
  return {
    id: 'ref-1',
    kind: 'references',
    name: 'Switch repo',
    description: 'The code',
    instructions: 'Read the README',
    ownerId: 'me',
    ownerName: 'Me',
    readVisibility: 'public',
    writeVisibility: 'private',
    type: 'github',
    typeLabel: 'GitHub',
    urls: ['https://github.com/acme/switch'],
    attachedRoomsCount: 1,
    packageIds: [],
    createdAt: '2026-11-01',
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.admin = false;
  state.items = {
    references: [
      item({}),
      item({
        id: 'ref-2',
        name: 'Tracker',
        ownerId: 'bob',
        ownerName: 'Bob',
        type: 'jira',
        typeLabel: 'Jira',
        attachedRoomsCount: 0,
      }),
    ],
    documents: [
      item({ id: 'doc-1', kind: 'documents', name: 'Style guide', type: null, typeLabel: null }),
    ],
  };
  state.rooms = [{ roomId: 'room-1', roomName: 'design' }];
  for (const fn of Object.values(rpcMock)) fn.mockReset();
  rpcMock.listLibraryItems.mockImplementation(
    async ({ kind }: { kind: 'references' | 'documents' }) => state.items[kind]
  );
  rpcMock.getLibraryItem.mockImplementation(async () => state.item);
  rpcMock.listLibraryItemRooms.mockImplementation(async () => state.rooms);
  rpcMock.listReferenceTypes.mockResolvedValue([
    {
      type: 'github',
      displayName: 'GitHub',
      valueHint: 'Repositories',
      isBuiltin: true,
      ownerName: null,
    },
  ]);
  rpcMock.listLibrary.mockResolvedValue([]);
  rpcMock.updateLibraryItem.mockResolvedValue({});
  rpcMock.setRoomResourceAttached.mockResolvedValue(undefined);
  showModal.mockReset();
  navigate.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(Panel: React.ComponentType): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>
    )
  );
  await settle();
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
};
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const cardNames = () =>
  [...container.querySelectorAll('[data-library-card] h3')].map((h) => h.textContent);
const cardFor = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-library-card]')].find(
    (card) => card.querySelector('h3')?.textContent === name
  )!;

describe('the Library page', () => {
  beforeEach(() => {
    state.params = { serverId: 'srv' };
  });

  it('lists references as cards, saying whose each is, its access and its rooms', async () => {
    await render(libraryView.MainPanel);
    expect(cardNames()).toEqual(['Switch repo', 'Tracker']);
    const mine = cardFor('Switch repo').textContent;
    expect(mine).toContain('Yours');
    expect(mine).toContain('GitHub');
    expect(mine).toContain('Shared');
    expect(mine).toContain('Owned by you');
    expect(mine).toContain('In 1 room');
    expect(cardFor('Tracker').textContent).toContain('Owned by Bob');
    // A reference's links may be private: they stay on its page.
    expect(container.textContent).not.toContain('github.com/acme');
  });

  it('narrows to yours, and switches to documents', async () => {
    await render(libraryView.MainPanel);
    await act(async () => button('Mine')!.click());
    expect(cardNames()).toEqual(['Switch repo']);
    await act(async () => button('Documents')!.click());
    await settle();
    expect(cardNames()).toEqual(['Style guide']);
    expect(button('New document')).toBeDefined();
  });

  it('offers deleting only on what you own, unless you administer the workspace', async () => {
    await render(libraryView.MainPanel);
    expect(
      cardFor('Switch repo').querySelector('[aria-label="Switch repo actions"]')
    ).not.toBeNull();
    expect(cardFor('Tracker').querySelector('[aria-label="Tracker actions"]')).toBeNull();
  });

  it('lets an admin delete anyone’s', async () => {
    state.admin = true;
    await render(libraryView.MainPanel);
    expect(cardFor('Tracker').querySelector('[aria-label="Tracker actions"]')).not.toBeNull();
  });

  it('opens New reference for the shown kind', async () => {
    await render(libraryView.MainPanel);
    await act(async () => button('New reference')!.click());
    expect(showModal).toHaveBeenCalledWith(
      'newLibraryItemModal',
      expect.objectContaining({ workspaceId: 'ws', kind: 'references' })
    );
  });

  it('says where an agent’s room documents are, since they are not listed here', async () => {
    await render(libraryView.MainPanel);
    expect(container.textContent).not.toContain('belong to that room');
    await act(async () => button('Documents')!.click());
    await settle();
    expect(container.textContent).toContain('Find them in the room’s Resources tab.');
  });

  it('calls the page Resources, as the gateway does', async () => {
    await render(libraryView.MainPanel);
    expect(container.querySelector('h1, h2')?.textContent).toBe('Resources');
  });

  it('says so when there is nothing yet', async () => {
    state.items.references = [];
    await render(libraryView.MainPanel);
    expect(container.textContent).toContain('No references here yet');
  });
});

describe('an item’s page', () => {
  beforeEach(() => {
    state.params = { serverId: 'srv', kind: 'references', itemId: 'ref-1' };
  });

  it('shows its links, instructions and rooms', async () => {
    state.item = item({});
    await render(libraryItemView.MainPanel);
    expect(container.textContent).toContain('https://github.com/acme/switch');
    expect(container.textContent).toContain('Read the README');
    expect(container.querySelector('[aria-label="Rooms"]')?.textContent).toContain('design');
  });

  it('saves only what changed', async () => {
    state.item = item({});
    await render(libraryItemView.MainPanel);
    await act(async () => button('Edit')!.click());
    const description = [...container.querySelectorAll('input')].find(
      (input) => input.value === 'The code'
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(description, 'All the code');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save')!.click());
    await settle();
    expect(rpcMock.updateLibraryItem).toHaveBeenCalledWith({
      workspaceId: 'ws',
      kind: 'references',
      itemId: 'ref-1',
      changes: { description: 'All the code' },
    });
  });

  it('offers no edit or delete on someone else’s shared item', async () => {
    state.item = item({ ownerId: 'bob', ownerName: 'Bob' });
    await render(libraryItemView.MainPanel);
    expect(button('Edit')).toBeUndefined();
    expect(button('Delete')).toBeUndefined();
  });

  it('lets anyone edit an open item, but not delete it', async () => {
    state.item = item({ ownerId: 'bob', ownerName: 'Bob', writeVisibility: 'public' });
    await render(libraryItemView.MainPanel);
    expect(button('Edit')).toBeDefined();
    expect(button('Delete')).toBeUndefined();
  });

  it('attaches it to another room from here', async () => {
    state.item = item({});
    await render(libraryItemView.MainPanel);
    await act(async () => button('Attach to rooms')!.click());
    await settle();
    // design already has it; support does not.
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    expect(dialog.textContent).toContain('support');
    expect(dialog.textContent).not.toContain('design');
    const attach = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Attach')!;
    await act(async () => attach.click());
    await settle();
    expect(rpcMock.setRoomResourceAttached).toHaveBeenCalledWith({
      workspaceId: 'ws',
      roomId: 'room-2',
      kind: 'references',
      resourceId: 'ref-1',
      attached: true,
    });
  });

  it('counts the rooms you cannot open without naming them', async () => {
    state.item = item({ hiddenRoomsCount: 2 });
    await render(libraryItemView.MainPanel);
    expect(container.querySelector('[aria-label="Rooms"]')?.textContent).toContain(
      'And 2 private rooms you can’t open.'
    );
  });

  it('says so when every room it is in is one you cannot open', async () => {
    state.item = item({ hiddenRoomsCount: 1 });
    state.rooms = [];
    await render(libraryItemView.MainPanel);
    expect(container.querySelector('[aria-label="Rooms"]')?.textContent).toContain(
      'Only in 1 private room you can’t open.'
    );
  });

  it('follows the server on who may detach from each room', async () => {
    state.item = item({});
    state.rooms = [
      { roomId: 'room-1', roomName: 'design', canUnlink: false },
      { roomId: 'room-2', roomName: 'support', canUnlink: true },
    ] as never;
    await render(libraryItemView.MainPanel);
    expect(container.querySelector('[aria-label="Detach from design"]')).toBeNull();
    expect(container.querySelector('[aria-label="Detach from support"]')).not.toBeNull();
  });

  it('renders a document’s content as markdown', async () => {
    state.params = { serverId: 'srv', kind: 'documents', itemId: 'doc-1' };
    state.item = {
      ...item({ id: 'doc-1', kind: 'documents', type: null, typeLabel: null, urls: [] }),
      content: '# Style\n\nUse **plain** words.',
    };
    await render(libraryItemView.MainPanel);
    const content = container.querySelector('[aria-label="Content"]')!;
    expect(content.textContent).toContain('Style');
    expect(content.textContent).not.toContain('# Style');
    expect(content.querySelector('strong')?.textContent).toBe('plain');
  });
});

describe('deleting', () => {
  const renderDelete = (over: Partial<LibraryItem>) =>
    render(() => (
      <Dialog open>
        <DialogContent>
          <DeleteLibraryItemModal
            workspaceId="ws"
            item={item(over)}
            onSuccess={() => {}}
            onClose={() => {}}
          />
        </DialogContent>
      </Dialog>
    ));
  const dialogText = () => document.querySelector('[data-slot="dialog-content"]')?.textContent;

  it('names the rooms it leaves, and counts those you cannot open', async () => {
    await renderDelete({ hiddenRoomsCount: 2 });
    expect(dialogText()).toContain('design');
    expect(dialogText()).toContain('and 2 private rooms you can’t open');
  });

  it('counts the rooms you cannot open when they are all it is in', async () => {
    state.rooms = [];
    await renderDelete({ hiddenRoomsCount: 1 });
    expect(dialogText()).toContain('It is removed from 1 private room you can’t open.');
  });
});
