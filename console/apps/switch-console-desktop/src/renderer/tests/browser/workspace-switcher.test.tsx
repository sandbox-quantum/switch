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
    setActive: state.setActive,
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
  useToast: () => ({ toast: () => {} }),
}));

import { WorkspaceSwitcher } from '@renderer/features/switch-servers/workspace-switcher';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function server(id: string, name: string): SwitchServer {
  return {
    id,
    name,
    gatewayUrl: `https://${id}.example.invalid`,
    apiUrl: `https://${id}.example.invalid/api`,
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
  activeId: string
): Promise<void> {
  state.servers = servers;
  state.workspaces = workspaces;
  state.activeId = activeId;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<WorkspaceSwitcher />));

  const trigger = container.querySelector<HTMLElement>('[aria-label="Switch workspace"]');
  expect(trigger, 'the switcher did not render its trigger').not.toBeNull();
  await act(async () => trigger!.click());
}

/** The menu row offering a workspace, by the name shown on it. */
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.startsWith(name)
  );
  expect(found, `no row for ${name}`).toBeDefined();
  return found!;
}

beforeEach(() => {
  state.setActive.mockReset().mockResolvedValue(undefined);
  state.navigate.mockReset();
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
        (item) => item.querySelector('span')?.textContent
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
