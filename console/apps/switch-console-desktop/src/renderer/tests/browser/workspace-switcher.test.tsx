import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace, WorkspaceRole } from '@shared/core/workspaces/workspaces';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const state = vi.hoisted(() => ({
  servers: [] as { id: string; name: string }[],
  workspaces: [] as {
    id: string;
    serverId: string;
    name: string;
    tenantId: string | null;
    role: string | null;
  }[],
  activeId: null as string | null,
  setActive: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  unavailable: new Set<string>(),
  noMembership: new Set<string>(),
  listPendingInvitations: vi.fn(),
  acceptPendingInvitation: vi.fn(),
  listJoinableWorkspaces: vi.fn(),
  joinByDomain: vi.fn(),
  cloud: 'open' as 'reading' | 'closed' | 'open' | 'failed',
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    switchServers: {
      listPendingInvitations: state.listPendingInvitations,
      listJoinableWorkspaces: state.listJoinableWorkspaces,
    },
  },
  events: { on: () => () => {}, emit: () => {} },
}));

vi.mock('@renderer/features/switch-servers/use-switch-cloud', () => ({
  useSwitchCloud: () =>
    state.cloud === 'open'
      ? { kind: 'open', url: 'https://cloud.example.invalid' }
      : state.cloud === 'failed'
        ? { kind: 'failed', headline: 'broken', detail: null }
        : { kind: state.cloud },
}));

vi.mock('@renderer/features/switch-servers/server-availability', () => ({
  serverAvailability: (serverId: string) =>
    state.unavailable.has(serverId) ? 'signed-out' : 'available',
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    init: () => Promise.resolve(),
    recoverStale: () => Promise.resolve(),
    get servers() {
      return state.servers;
    },
    serverById: (id: string) => state.servers.find((s) => s.id === id) ?? null,
  },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    get activeId() {
      return state.activeId;
    },
    get active() {
      return state.workspaces.find((w) => w.id === state.activeId) ?? null;
    },
    onServer: (serverId: string) => state.workspaces.filter((w) => w.serverId === serverId),
    hasNoMembership: (serverId: string) => state.noMembership.has(serverId),
    setActive: state.setActive,
    acceptPendingInvitation: state.acceptPendingInvitation,
    joinByDomain: state.joinByDomain,
  },
}));

vi.mock('@renderer/features/switch-servers/local-server-store', () => ({
  localServerStore: { init: () => Promise.resolve(), dispose: () => {}, phase: 'stopped' },
}));

vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: { init: () => Promise.resolve(), dispose: () => {} },
}));

// Presentation of a server — its avatar, icon, status words and drift — is the
// server's business and tested with it. Stubbed so this test is about which
// workspaces the switcher offers and which it refuses.
vi.mock('@renderer/features/switch-servers/server-presentation', () => ({
  ServerAvatar: () => null,
  ServerDriftIndicator: () => null,
  ServerStatusDot: () => null,
  serverDrift: () => null,
  serverPlacementLabel: () => null,
  serverStatusLabel: (server: SwitchServer) => `${server.name} status`,
  serverSubtitleLabel: (server: SwitchServer) => `${server.name} status`,
}));

vi.mock('@renderer/features/switch-servers/server-icon', () => ({
  serverIcon: () => () => null,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => () => {},
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: state.toast }),
}));

import {
  serverRowWorkspace,
  showsServers,
  WorkspaceSwitcher,
} from '@renderer/features/switch-servers/workspace-switcher';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function server(id: string, name: string): SwitchServer {
  return {
    id,
    name,
    url: `https://${id}.example.invalid/api`,
    dashboardUrl: `https://${id}.example.invalid`,
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function workspace(
  id: string,
  serverId: string,
  patch: { tenantId?: string | null; role?: WorkspaceRole | null } = {}
): Workspace {
  const tenantId = patch.tenantId === undefined ? `tenant-${id}` : patch.tenantId;
  return {
    id,
    serverId,
    name: id,
    tenantId,
    slug: tenantId === null ? null : id,
    role: patch.role === undefined ? 'member' : patch.role,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/** Mount the switcher on the given servers and workspaces, and open its menu. */
async function openSwitcher(
  servers: SwitchServer[],
  workspaces: Workspace[],
  activeId: string,
  trigger: 'Switch workspace' | 'Switch server' = 'Switch workspace'
): Promise<void> {
  state.servers = servers;
  state.workspaces = workspaces;
  state.activeId = activeId;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <WorkspaceSwitcher />
      </QueryClientProvider>
    )
  );
  await settle();

  const button = container.querySelector<HTMLElement>(`[aria-label="${trigger}"]`);
  expect(button, `the switcher did not render its ${trigger} trigger`).not.toBeNull();
  await act(async () => button!.click());
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

/** The menu row offering a workspace, by the name shown on it. */
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.querySelector('[data-row-name]')?.textContent?.startsWith(name)
  );
  expect(found, `no row for ${name}`).toBeDefined();
  return found!;
}

beforeEach(() => {
  state.cloud = 'open';
  state.setActive.mockReset().mockResolvedValue(undefined);
  state.navigate.mockReset();
  state.toast.mockReset();
  state.unavailable.clear();
  state.noMembership.clear();
  state.listPendingInvitations.mockReset().mockResolvedValue({ kind: 'listed', invitations: [] });
  state.acceptPendingInvitation.mockReset();
  state.listJoinableWorkspaces.mockReset().mockResolvedValue({ kind: 'listed', workspaces: [] });
  state.joinByDomain.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('the workspaces the switcher offers', () => {
  // A workspace only means anything on its server — two servers can each have a
  // "Default" — so a flat list would offer two rows that read identically.
  it('lists the workspaces on a server under that server', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Local dev')],
      [workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1'), workspace('ws-c', 'srv-2')],
      'ws-a'
    );

    const groups = [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-group"]')];
    const listed = groups.map((group) => [
      group.querySelector('[data-slot="dropdown-menu-label"]')?.textContent,
      // The first span on a row is its name; a second one, where there is one,
      // is the role or the reason it cannot be opened.
      [...group.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.querySelector('[data-row-name]')?.textContent
      ),
    ]);

    expect(listed[0]?.[0]).toContain('Acme');
    expect(listed[0]?.[1]).toEqual(['ws-a', 'ws-b']);
    expect(listed[1]?.[0]).toContain('Local dev');
    expect(listed[1]?.[1]).toEqual(['ws-c']);
  });

  it('marks the one the window is scoped to', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme')],
      [workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1')],
      'ws-b'
    );

    expect(row('ws-a').getAttribute('aria-current')).toBeNull();
    expect(row('ws-b').getAttribute('aria-current')).toBe('true');
  });

  it('switches to the one clicked', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme')],
      [workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1')],
      'ws-a'
    );

    await act(async () => row('ws-b').click());

    expect(state.setActive).toHaveBeenCalledWith('ws-b');
  });
});

/**
 * Two rows the gateway will refuse every call scoped to. Both are kept in the
 * list rather than hidden, because their agents are still here and the row is
 * the only thing that says where they went — so both have to be unclickable and
 * both have to say why, or the app turns a fact it already knows into an error
 * after the click.
 */
describe('a workspace that cannot be opened', () => {
  it('refuses one this account is no longer a member of', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme')],
      [workspace('ws-a', 'srv-1'), workspace('ws-gone', 'srv-1', { role: null })],
      'ws-a'
    );

    const gone = row('ws-gone');
    expect(gone.getAttribute('aria-disabled')).toBe('true');
    expect(gone.textContent).toContain('No longer a member');
    expect(gone.title).toContain('no longer a member');
  });

  /**
   * The row every server is registered with, before the gateway has been asked
   * which workspaces the account has. Once the account turns out to have more
   * than one, nothing can say which this row meant — and a call scoped to it
   * selects no tenant at all, so the gateway answers under whichever workspace
   * the session last selected.
   */
  it('refuses a placeholder the reconcile could not match', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme')],
      [
        workspace('ws-placeholder', 'srv-1', { tenantId: null, role: null }),
        workspace('ws-a', 'srv-1'),
      ],
      'ws-a'
    );

    const placeholder = row('ws-placeholder');
    expect(placeholder.getAttribute('aria-disabled')).toBe('true');
    expect(placeholder.textContent).toContain('Not matched');
  });

  /**
   * The same state on a server holding one workspace is ordinary rather than
   * broken: there is nothing to confuse it with, and the gateway resolves the
   * account's sole membership to exactly that row. Refusing it would lock the
   * window out of a freshly registered server until a reconcile had run.
   */
  it('still offers a lone workspace that has no tenant yet', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme')],
      [workspace('ws-only', 'srv-1', { tenantId: null, role: null })],
      'ws-only'
    );

    const only = row('ws-only');
    expect(only.getAttribute('aria-disabled')).toBeNull();
    expect(only.textContent).toBe('ws-only');
  });

  it('says what to do instead of sending you back through sign-in', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme')],
      [
        workspace('ws-placeholder', 'srv-1', { tenantId: null, role: null }),
        workspace('ws-a', 'srv-1'),
      ],
      'ws-a'
    );

    // Signing in re-runs the reconcile, which is what left the row unmatched and
    // would do so again — so the row must not offer it as the way out.
    const reason = row('ws-placeholder').title;
    expect(reason).toContain('Open one of the others');
    expect(reason).not.toMatch(/sign in/i);
  });
});

describe('inviting people from the switcher', () => {
  function inviteItem(): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith('Invite people')
    );
  }

  it('is offered in a workspace the account administers', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme')],
      [workspace('ws-a', 'srv-1', { role: 'admin' })],
      'ws-a'
    );

    expect(inviteItem()?.textContent).toBe('Invite people to ws-a…');
  });

  it('is not offered to a member, whom the server would refuse', async () => {
    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');

    expect(inviteItem()).toBeUndefined();
  });
});

describe('invitations to your address in the switcher', () => {
  function invitation(id: string, workspaceName: string) {
    return {
      id,
      tenantId: `tenant-${id}`,
      workspaceName,
      role: 'member',
      expiresAt: '2026-12-01T00:00:00Z',
      invitedBy: 'Ada Lovelace',
    };
  }

  function invitationItems(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid="pending-invitation-item"]')];
  }

  it('counts them on the button and lists them under their server', async () => {
    state.listPendingInvitations.mockResolvedValue({
      kind: 'listed',
      invitations: [invitation('inv-1', 'Skunkworks'), invitation('inv-2', 'Labs')],
    });

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');

    expect(container!.querySelector('[aria-label="2 invitations waiting"]')).not.toBeNull();
    expect(invitationItems().map((item) => item.textContent)).toEqual([
      'SkunkworksInvited',
      'LabsInvited',
    ]);
    expect(invitationItems()[0]!.title).toBe('Ada Lovelace invited you as member');
  });

  it('shows nothing on a server too old to list them', async () => {
    state.listPendingInvitations.mockResolvedValue({ kind: 'unsupported' });

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');

    expect(container!.querySelector('[aria-label$="waiting"]')).toBeNull();
    expect(invitationItems()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('invitations to your address');
  });

  it('says so when the server could not be asked', async () => {
    state.listPendingInvitations.mockRejectedValue(new Error('gateway unreachable'));

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');

    expect(document.body.textContent).toContain('Could not check for invitations to your address.');
  });

  it('does not ask a server you are not signed in to', async () => {
    state.unavailable.add('srv-2');

    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Local dev')],
      [workspace('ws-a', 'srv-1'), workspace('ws-c', 'srv-2')],
      'ws-a'
    );

    expect(state.listPendingInvitations).toHaveBeenCalledWith('srv-1');
    expect(state.listPendingInvitations).not.toHaveBeenCalledWith('srv-2');
  });

  it('accepts one, opens the workspace it joins and asks again', async () => {
    state.listPendingInvitations.mockResolvedValue({
      kind: 'listed',
      invitations: [invitation('inv-1', 'Skunkworks')],
    });
    state.acceptPendingInvitation.mockResolvedValue(workspace('ws-new', 'srv-1'));

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');
    await act(async () => invitationItems()[0]!.click());
    await settle();

    expect(state.acceptPendingInvitation).toHaveBeenCalledWith(
      'srv-1',
      expect.objectContaining({ id: 'inv-1' })
    );
    expect(state.setActive).toHaveBeenCalledWith('ws-new');
    expect(state.navigate).toHaveBeenCalledWith('server', { serverId: 'srv-1' });
    expect(state.listPendingInvitations).toHaveBeenCalledTimes(2);
  });

  it('says why when accepting fails, and asks again', async () => {
    state.listPendingInvitations.mockResolvedValue({
      kind: 'listed',
      invitations: [invitation('inv-1', 'Skunkworks')],
    });
    state.acceptPendingInvitation.mockRejectedValue(new Error('This invitation has been revoked'));

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');
    await act(async () => invitationItems()[0]!.click());
    await settle();

    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Could not join Skunkworks',
        description: expect.stringContaining('This invitation has been revoked'),
      })
    );
    expect(state.setActive).not.toHaveBeenCalled();
    expect(state.listPendingInvitations).toHaveBeenCalledTimes(2);
  });
});

describe('workspaces open to your e-mail domain', () => {
  function joinableItems(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid="joinable-workspace-item"]')];
  }

  it('lists them under their server without counting them as invitations', async () => {
    state.listJoinableWorkspaces.mockResolvedValue({
      kind: 'listed',
      workspaces: [{ tenantId: 't-9', workspaceName: 'Skunkworks', domain: 'acme.example' }],
    });

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');

    expect(container!.querySelector('[aria-label$="waiting"]')).toBeNull();
    expect(joinableItems().map((item) => item.textContent)).toEqual(['SkunkworksJoin']);
    expect(joinableItems()[0]!.title).toBe('Open to anyone at acme.example');
  });

  it('joins one, opens it and asks again', async () => {
    state.listJoinableWorkspaces.mockResolvedValue({
      kind: 'listed',
      workspaces: [{ tenantId: 't-9', workspaceName: 'Skunkworks', domain: 'acme.example' }],
    });
    state.joinByDomain.mockResolvedValue(workspace('ws-new', 'srv-1'));

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');
    await act(async () => joinableItems()[0]!.click());
    await settle();

    expect(state.joinByDomain).toHaveBeenCalledWith(
      'srv-1',
      expect.objectContaining({ tenantId: 't-9' })
    );
    expect(state.setActive).toHaveBeenCalledWith('ws-new');
    expect(state.listJoinableWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('says so when the server could not be asked', async () => {
    state.listJoinableWorkspaces.mockRejectedValue(new Error('gateway unreachable'));

    await openSwitcher([server('srv-1', 'Acme')], [workspace('ws-a', 'srv-1')], 'ws-a');

    expect(document.body.textContent).toContain(
      'Could not check for workspaces open to your e-mail domain.'
    );
  });
});

describe('which switcher a build shows', () => {
  it('shows workspaces when the build can reach Switch Cloud', () => {
    expect(showsServers('open')).toBe(false);
  });

  it('shows workspaces when the Cloud configuration is broken, so it is not hidden', () => {
    expect(showsServers('failed')).toBe(false);
  });

  it('shows servers on a build without Switch Cloud', () => {
    expect(showsServers('closed')).toBe(true);
    expect(showsServers('reading')).toBe(true);
  });
});

describe('the workspace a server row opens', () => {
  it('stays in the active workspace when it is on that server', () => {
    const ws = [workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1')];
    expect(serverRowWorkspace(ws, 'ws-b').workspace?.id).toBe('ws-b');
  });

  it('otherwise opens the first one that can be opened', () => {
    const ws = [workspace('ws-a', 'srv-1', { tenantId: null }), workspace('ws-b', 'srv-1')];
    expect(serverRowWorkspace(ws, 'elsewhere').workspace?.id).toBe('ws-b');
  });

  it('opens nothing on a server with no workspace', () => {
    expect(serverRowWorkspace([], null)).toEqual({ workspace: null, unavailable: null });
  });
});

describe('the server switcher on a build without Switch Cloud', () => {
  beforeEach(() => {
    state.cloud = 'closed';
  });

  function serverRow(name: string): HTMLElement {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.querySelector('span span')?.textContent?.startsWith(name)
    );
    expect(found, `no row for ${name}`).toBeDefined();
    return found!;
  }

  it('lists servers, not workspaces, and offers no workspace actions', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Local dev')],
      [workspace('ws-a', 'srv-1', { role: 'owner' }), workspace('ws-c', 'srv-2')],
      'ws-a',
      'Switch server'
    );

    expect(serverRow('Acme').getAttribute('aria-current')).toBe('true');
    expect(serverRow('Local dev').getAttribute('aria-current')).toBeNull();
    expect(document.body.textContent).not.toContain('New workspace');
    expect(document.body.textContent).not.toContain('Invite people');
  });

  it("switches to a server's workspace when the server is clicked", async () => {
    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Local dev')],
      [workspace('ws-a', 'srv-1'), workspace('ws-c', 'srv-2')],
      'ws-a',
      'Switch server'
    );

    await act(async () => serverRow('Local dev').click());

    expect(state.setActive).toHaveBeenCalledWith('ws-c');
    expect(state.navigate).toHaveBeenCalledWith('server', { serverId: 'srv-2' });
  });

  it('refuses a server that has no workspace yet, and says why', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Half set up')],
      [workspace('ws-a', 'srv-1')],
      'ws-a',
      'Switch server'
    );

    const half = serverRow('Half set up');
    expect(half.getAttribute('title')).toContain('not finished being set up');
    await act(async () => half.click());
    expect(state.setActive).not.toHaveBeenCalled();
  });

  it('keeps the server list when a server holds two workspaces', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Local dev')],
      [workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1'), workspace('ws-c', 'srv-2')],
      'ws-c',
      'Switch server'
    );

    expect(document.body.textContent).not.toContain('ws-b');
    await act(async () => serverRow('Acme').click());
    expect(state.setActive).toHaveBeenCalledWith('ws-a');
  });
});

describe('finding a workspace in the menu', () => {
  async function type(text: string): Promise<void> {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a workspace"]');
    expect(input, 'no search box').not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, text);
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function names(): (string | null | undefined)[] {
    return [...document.querySelectorAll('[role="menuitem"] [data-row-name]')].map(
      (el) => el.textContent
    );
  }

  it('narrows the list to the workspaces whose name matches', async () => {
    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Local dev')],
      [workspace('platform', 'srv-1'), workspace('docs', 'srv-1'), workspace('scratch', 'srv-2')],
      'platform'
    );

    await type('doc');

    expect(names()).toEqual(['docs']);
    expect(document.body.textContent).not.toContain('Local dev');
  });

  it("keeps all of a server's workspaces when the server's name matches", async () => {
    await openSwitcher(
      [server('srv-1', 'Acme'), server('srv-2', 'Local dev')],
      [workspace('platform', 'srv-1'), workspace('docs', 'srv-1'), workspace('scratch', 'srv-2')],
      'platform'
    );

    await type('acme');

    expect(names()).toEqual(['platform', 'docs']);
  });

  it('says so when nothing matches', async () => {
    await openSwitcher([server('srv-1', 'Acme')], [workspace('platform', 'srv-1')], 'platform');

    await type('zzz');

    expect(names()).toEqual([]);
    expect(document.body.textContent).toContain('No workspace or server matches');
  });
});

describe('the server headings', () => {
  it('marks the Switch Cloud server as official and names where the others are', async () => {
    await openSwitcher(
      [server('cloud', 'Switch Cloud'), server('srv-2', 'Local dev')],
      [workspace('ws-a', 'cloud'), workspace('ws-b', 'srv-2')],
      'ws-a'
    );

    const labels = [...document.querySelectorAll('[data-slot="dropdown-menu-label"]')].map(
      (el) => el.textContent
    );
    expect(labels[0]).toContain('Official');
    expect(labels[1]).toContain('srv-2.example.invalid');
    expect(labels[1]).not.toContain('Official');
  });
});

describe('a server with no workspace to show yet', () => {
  function menuText(): string[] {
    return [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');
  }

  it('offers Sign in… instead of a workspace named after a server you are signed out of', async () => {
    state.unavailable.add('cloud');
    await openSwitcher(
      [server('srv-1', 'Acme'), server('cloud', 'Switch Cloud')],
      [workspace('ws-a', 'srv-1'), { ...workspace('Switch Cloud', 'cloud', { tenantId: null }) }],
      'ws-a'
    );

    expect(menuText()).toContain('Sign in…');
    expect(names()).not.toContain('Switch Cloud');

    const signIn = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent === 'Sign in…'
    );
    await act(async () => signIn!.click());
    expect(state.setActive).toHaveBeenCalledWith('Switch Cloud');
    expect(state.navigate).toHaveBeenCalledWith('server', { serverId: 'cloud' });
  });

  it('says there is no workspace yet when the account belongs to none', async () => {
    state.noMembership.add('cloud');
    await openSwitcher(
      [server('srv-1', 'Acme'), server('cloud', 'Switch Cloud')],
      [workspace('ws-a', 'srv-1'), workspace('Switch Cloud', 'cloud', { tenantId: null })],
      'ws-a'
    );

    expect(document.body.textContent).toContain('No workspace yet');
    expect(menuText()).toContain('Create a workspace…');
    expect(names()).not.toContain('Switch Cloud');
  });

  it('names the button after the missing workspace while the placeholder is open', async () => {
    state.noMembership.add('cloud');
    state.servers = [server('cloud', 'Switch Cloud')];
    state.workspaces = [workspace('Switch Cloud', 'cloud', { tenantId: null })];
    state.activeId = 'Switch Cloud';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () =>
      root!.render(
        <QueryClientProvider client={client}>
          <WorkspaceSwitcher />
        </QueryClientProvider>
      )
    );

    const trigger = container.querySelector('[aria-label="Switch workspace"]');
    expect(trigger?.textContent).toContain('No workspace yet');
  });
});

function names(): (string | null | undefined)[] {
  return [...document.querySelectorAll('[role="menuitem"] [data-row-name]')].map(
    (el) => el.textContent
  );
}
