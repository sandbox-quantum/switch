/**
 * Where Switch's distributed Microsoft Teams app is placed: which teams it is
 * in, which is the default, and what to do when it is not catalogued yet.
 *
 * Offered only for a connection already known to be a running distributed
 * Teams bridge, so every failure case here is either transient (the bridge
 * just stopped) or Microsoft Graph itself declining — covered rather than
 * assumed, since each reads as its own sentence to an admin.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listBridgeTeams = vi.hoisted(() => vi.fn());
const addBridgeTeam = vi.hoisted(() => vi.fn());
const removeBridgeTeam = vi.hoisted(() => vi.fn());
const setDefaultTeamsTeam = vi.hoisted(() => vi.fn());
const downloadTeamsPackage = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

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
      listBridgeTeams,
      addBridgeTeam,
      removeBridgeTeam,
      setDefaultTeamsTeam,
      downloadTeamsPackage,
    },
  },
  events: { on: () => () => {}, emit: () => {} },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

import { TeamsPlacementModal } from '@renderer/features/switch-servers/TeamsPlacementModal';
import { Dialog } from '@renderer/lib/ui/dialog';
import type { TeamsTeam } from '@shared/core/switch-servers/switch-servers';

const onSuccess = vi.fn();
const onClose = vi.fn();

function team(overrides: Partial<TeamsTeam> = {}): TeamsTeam {
  return {
    teamId: 't1',
    name: 'Engineering',
    hasSwitch: true,
    isDefault: false,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  listBridgeTeams.mockReset();
  addBridgeTeam.mockReset();
  removeBridgeTeam.mockReset();
  setDefaultTeamsTeam.mockReset();
  downloadTeamsPackage.mockReset();
  toast.mockReset();
  onSuccess.mockReset();
  onClose.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
  await act(async () =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Dialog open onOpenChange={() => {}}>
          <TeamsPlacementModal
            workspaceId="ws-1"
            bridgeId="b-1"
            bridgeDisplayName="Contoso Teams"
            onSuccess={onSuccess}
            onClose={onClose}
          />
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

/** Under fake timers: let `ms` pass, including React Query's own scheduling. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
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

/** A promise the test resolves on its own schedule, to pin a request mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('loading and fetch failure', () => {
  it('shows a loading state while the teams list is in flight', async () => {
    const { promise } = deferred<unknown>();
    listBridgeTeams.mockReturnValue(promise);

    const el = await render();

    expect(el.textContent).toContain('Loading teams');
  });

  it('reports a transport failure reading the teams list', async () => {
    listBridgeTeams.mockRejectedValue(new Error('network down'));

    const el = await render();

    expect(el.textContent).toContain('Could not read this connection’s teams.');
  });
});

describe('non-listed results', () => {
  it('says a connection no longer on the distributed app does not support this', async () => {
    listBridgeTeams.mockResolvedValue({ kind: 'not-distributed-teams' });
    const el = await render();
    expect(el.textContent).toContain('no longer supports Microsoft Teams team placement');
  });

  it('shows the server’s own sentence for a bridge that does not come back', async () => {
    vi.useFakeTimers();
    try {
      listBridgeTeams.mockResolvedValue({
        kind: 'not-running',
        message: 'The connection is not running; try again in a moment.',
      });
      const el = await render();
      await tick(0);
      expect(el.textContent).toContain('The connection is restarting with your change');
      expect(el.textContent).not.toContain('not running');

      for (let i = 0; i < 21; i++) await tick(1500);

      expect(el.textContent).toContain('The connection is not running; try again in a moment.');
      expect(el.textContent).not.toContain('restarting with your change');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out a restart, then lists the teams', async () => {
    vi.useFakeTimers();
    try {
      listBridgeTeams
        .mockResolvedValueOnce({ kind: 'not-running', message: 'not running' })
        .mockResolvedValue({
          kind: 'listed',
          teams: [team({ teamId: 't1', name: 'Engineering', isDefault: true })],
          defaultTeamId: 't1',
          inCatalog: true,
          catalogProblem: null,
        });
      const el = await render();
      await tick(0);
      expect(el.textContent).toContain('The connection is restarting with your change');

      await tick(2000);

      expect(el.textContent).toContain('Engineering');
      expect(el.textContent).not.toContain('not running');
      expect(el.textContent).not.toContain('restarting with your change');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the server’s own sentence for Microsoft Graph’s refusal', async () => {
    listBridgeTeams.mockResolvedValue({
      kind: 'microsoft-refused',
      message: 'Microsoft refused: too many requests',
    });
    const el = await render();
    expect(el.textContent).toContain('Microsoft refused: too many requests');
  });

  it('prompts a sign-in for an expired session', async () => {
    listBridgeTeams.mockResolvedValue({ kind: 'unauthenticated' });
    const el = await render();
    expect(el.textContent).toContain('Your session for this server expired');
  });

  it('names the admin requirement for a non-admin', async () => {
    listBridgeTeams.mockResolvedValue({ kind: 'forbidden' });
    const el = await render();
    expect(el.textContent).toContain('requires an owner or admin of this workspace');
  });

  it('shows a generic error’s own message', async () => {
    listBridgeTeams.mockResolvedValue({ kind: 'error', message: 'boom' });
    const el = await render();
    expect(el.textContent).toContain('boom');
  });
});

describe('listing teams', () => {
  it('badges the chosen default', async () => {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [team({ teamId: 't1', name: 'Engineering', isDefault: true })],
      defaultTeamId: 't1',
      inCatalog: true,
      catalogProblem: null,
    });

    const el = await render();

    const row = [...el.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Engineering')
    );
    expect(row?.textContent).toContain('Default');
    // A default team offers no "Make default" of its own.
    expect(row?.textContent).not.toContain('Make default');
  });

  it('says when a team’s own apps could not be read', async () => {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [team({ hasSwitch: null })],
      defaultTeamId: null,
      inCatalog: true,
      catalogProblem: null,
    });

    const el = await render();

    expect(el.textContent).toContain('Switch could not read this team’s apps');
  });

  it('falls back to a plain sentence when the app is not catalogued and the server gives no reason', async () => {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [team({ hasSwitch: false })],
      defaultTeamId: null,
      inCatalog: false,
      catalogProblem: null,
    });

    const el = await render();

    expect(el.textContent).toContain('Switch is not in your organisation’s Teams app list yet.');
  });

  it('shows the server’s own catalogue problem when it has one', async () => {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [team({ hasSwitch: false })],
      defaultTeamId: null,
      inCatalog: false,
      catalogProblem: 'Publishing failed: the manifest was rejected.',
    });

    const el = await render();

    expect(el.textContent).toContain('Publishing failed: the manifest was rejected.');
  });
});

describe('adding Switch to a team', () => {
  function listed(overrides: { inCatalog?: boolean; catalogProblem?: string | null } = {}) {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [team({ hasSwitch: false, isDefault: false })],
      defaultTeamId: null,
      inCatalog: overrides.inCatalog ?? true,
      catalogProblem: overrides.catalogProblem ?? null,
    });
  }

  it('calls the RPC with the right ids and refreshes the list on success', async () => {
    listed();
    addBridgeTeam.mockResolvedValue({ kind: 'added' });
    const el = await render();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => button(el, 'Add').click());
    await settle();

    expect(addBridgeTeam).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-1',
      teamId: 't1',
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['bridge-teams', 'ws-1', 'b-1'] });
  });

  it('shows the catalogue failure’s own message', async () => {
    listed();
    addBridgeTeam.mockResolvedValue({ kind: 'not-in-catalog', message: 'Not catalogued yet.' });
    const el = await render();

    await act(async () => button(el, 'Add').click());
    await settle();

    expect(el.textContent).toContain('Not catalogued yet.');
  });

  it('prompts a sign-in on an expired session', async () => {
    listed();
    addBridgeTeam.mockResolvedValue({ kind: 'unauthenticated' });
    const el = await render();

    await act(async () => button(el, 'Add').click());
    await settle();

    expect(el.textContent).toContain('Your session for this server expired');
  });

  it('names the admin requirement when forbidden', async () => {
    listed();
    addBridgeTeam.mockResolvedValue({ kind: 'forbidden' });
    const el = await render();

    await act(async () => button(el, 'Add').click());
    await settle();

    expect(el.textContent).toContain('requires an owner or admin of this workspace');
  });

  it('shows a generic error’s own message', async () => {
    listed();
    addBridgeTeam.mockResolvedValue({ kind: 'error', message: 'add failed' });
    const el = await render();

    await act(async () => button(el, 'Add').click());
    await settle();

    expect(el.textContent).toContain('add failed');
  });

  it('shows a fallback message when the call throws rather than resolves', async () => {
    listed();
    addBridgeTeam.mockRejectedValue(new Error('rpc exploded'));
    const el = await render();

    await act(async () => button(el, 'Add').click());
    await settle();

    expect(el.textContent).toContain('Could not add Switch to Engineering.');
  });

  it('wraps a disabled Add in a span so the tooltip still fires when the app is not catalogued', async () => {
    listed({ inCatalog: false, catalogProblem: 'Not catalogued yet.' });
    const el = await render();

    const addButton = button(el, 'Add');
    expect(addButton.disabled).toBe(true);
    const wrapper = addButton.closest('span[tabindex="0"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute('aria-label')).toBe('Not catalogued yet.');
  });
});

describe('removing Switch from a team', () => {
  function listedWithSwitch(overrides: Partial<TeamsTeam> = {}) {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [team({ hasSwitch: true, ...overrides })],
      defaultTeamId: overrides.isDefault ? 't1' : null,
      inCatalog: true,
      catalogProblem: null,
    });
  }

  it('calls the RPC and refreshes both the team list and the bridge list', async () => {
    // Removing Switch from the current default also clears the default and
    // turns channel creation off on the server, so the bridge list (which
    // shows "Default" and channel-creation state) needs refreshing too.
    listedWithSwitch({ isDefault: true });
    removeBridgeTeam.mockResolvedValue({ kind: 'removed' });
    const el = await render();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => button(el, 'Remove').click());
    await settle();

    expect(removeBridgeTeam).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-1',
      teamId: 't1',
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['bridge-teams', 'ws-1', 'b-1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['remote-bridges', 'ws-1'] });
  });

  it('prompts a sign-in on an expired session', async () => {
    listedWithSwitch();
    removeBridgeTeam.mockResolvedValue({ kind: 'unauthenticated' });
    const el = await render();

    await act(async () => button(el, 'Remove').click());
    await settle();

    expect(el.textContent).toContain('Your session for this server expired');
  });

  it('names the admin requirement when forbidden', async () => {
    listedWithSwitch();
    removeBridgeTeam.mockResolvedValue({ kind: 'forbidden' });
    const el = await render();

    await act(async () => button(el, 'Remove').click());
    await settle();

    expect(el.textContent).toContain('requires an owner or admin of this workspace');
  });

  it('shows a generic error’s own message', async () => {
    listedWithSwitch();
    removeBridgeTeam.mockResolvedValue({ kind: 'error', message: 'remove failed' });
    const el = await render();

    await act(async () => button(el, 'Remove').click());
    await settle();

    expect(el.textContent).toContain('remove failed');
  });

  it('shows a fallback message when the call throws rather than resolves', async () => {
    listedWithSwitch();
    removeBridgeTeam.mockRejectedValue(new Error('rpc exploded'));
    const el = await render();

    await act(async () => button(el, 'Remove').click());
    await settle();

    expect(el.textContent).toContain('Could not remove Switch from Engineering.');
  });
});

describe('making a team the default', () => {
  function listedTwoTeams() {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [
        team({ teamId: 't1', name: 'Engineering', hasSwitch: true, isDefault: false }),
        team({ teamId: 't2', name: 'Sales', hasSwitch: true, isDefault: true }),
      ],
      defaultTeamId: 't2',
      inCatalog: true,
      catalogProblem: null,
    });
  }

  it('calls the RPC with the chosen team and refreshes both queries on success', async () => {
    listedTwoTeams();
    setDefaultTeamsTeam.mockResolvedValue({ kind: 'updated', bridge: {} });
    const el = await render();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => button(el, 'Make default').click());
    await settle();

    expect(setDefaultTeamsTeam).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-1',
      teamId: 't1',
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['bridge-teams', 'ws-1', 'b-1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['remote-bridges', 'ws-1'] });
  });

  it('keeps the choice saving through the restart it causes, then shows the new default', async () => {
    vi.useFakeTimers();
    try {
      listedTwoTeams();
      setDefaultTeamsTeam.mockResolvedValue({ kind: 'updated', bridge: {} });
      const el = await render();
      await tick(0);
      listBridgeTeams
        .mockResolvedValueOnce({ kind: 'not-running', message: 'not running' })
        .mockResolvedValue({
          kind: 'listed',
          teams: [
            team({ teamId: 't1', name: 'Engineering', hasSwitch: true, isDefault: true }),
            team({ teamId: 't2', name: 'Sales', hasSwitch: true, isDefault: false }),
          ],
          defaultTeamId: 't1',
          inCatalog: true,
          catalogProblem: null,
        });

      await act(async () => button(el, 'Make default').click());
      await tick(0);
      expect(el.textContent).toContain('The connection is restarting with your change');
      expect(el.textContent).toContain('Saving…');
      expect(el.textContent).not.toContain('not running');

      await tick(2000);

      expect(el.textContent).not.toContain('Saving…');
      expect(el.textContent).not.toContain('restarting with your change');
      // Sales is no longer the default, so it is the one offered the choice.
      const sales = [...el.querySelectorAll('li')].find((li) => li.textContent?.includes('Sales'));
      expect(sales?.textContent).toContain('Make default');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prompts a sign-in on an expired session', async () => {
    listedTwoTeams();
    setDefaultTeamsTeam.mockResolvedValue({ kind: 'unauthenticated' });
    const el = await render();

    await act(async () => button(el, 'Make default').click());
    await settle();

    expect(el.textContent).toContain('Your session for this server expired');
  });

  it('names the admin requirement when forbidden', async () => {
    listedTwoTeams();
    setDefaultTeamsTeam.mockResolvedValue({ kind: 'forbidden' });
    const el = await render();

    await act(async () => button(el, 'Make default').click());
    await settle();

    expect(el.textContent).toContain('requires an owner or admin of this workspace');
  });

  it('shows the server’s own sentence for a rejected choice (422 → invalid)', async () => {
    listedTwoTeams();
    setDefaultTeamsTeam.mockResolvedValue({
      kind: 'invalid',
      message: 'Switch is not in that team. Add it to the team first, then make it the default.',
    });
    const el = await render();

    await act(async () => button(el, 'Make default').click());
    await settle();

    expect(el.textContent).toContain(
      'Switch is not in that team. Add it to the team first, then make it the default.'
    );
  });

  it('shows the server’s own sentence for a transient failure (503/502 → error)', async () => {
    listedTwoTeams();
    setDefaultTeamsTeam.mockResolvedValue({
      kind: 'error',
      message: 'Microsoft could not be asked whether Switch is in team t1',
    });
    const el = await render();

    await act(async () => button(el, 'Make default').click());
    await settle();

    expect(el.textContent).toContain('Microsoft could not be asked whether Switch is in team t1');
  });

  it('shows a fallback message when the call throws rather than resolves', async () => {
    listedTwoTeams();
    setDefaultTeamsTeam.mockRejectedValue(new Error('rpc exploded'));
    const el = await render();

    await act(async () => button(el, 'Make default').click());
    await settle();

    expect(el.textContent).toContain('Could not make Engineering the default.');
  });
});

describe('saving the Teams app package', () => {
  function notCatalogued() {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [],
      defaultTeamId: null,
      inCatalog: false,
      catalogProblem: 'Not catalogued yet.',
    });
  }

  it('toasts the saved path on success', async () => {
    notCatalogued();
    downloadTeamsPackage.mockResolvedValue('/tmp/switch-teams-contoso-teams.zip');
    const el = await render();

    await act(async () => button(el, 'Save Teams app package').click());
    await settle();

    expect(downloadTeamsPackage).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-1',
      defaultFileName: 'Contoso-Teams.zip',
    });
    expect(toast).toHaveBeenCalledWith({
      title: 'Package saved',
      description: '/tmp/switch-teams-contoso-teams.zip',
    });
  });

  it('shows nothing when the save was cancelled', async () => {
    notCatalogued();
    downloadTeamsPackage.mockResolvedValue(null);
    const el = await render();

    await act(async () => button(el, 'Save Teams app package').click());
    await settle();

    expect(toast).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain('Could not save');
  });

  it('shows a failure message when saving throws', async () => {
    notCatalogued();
    downloadTeamsPackage.mockRejectedValue(new Error('disk full'));
    const el = await render();

    await act(async () => button(el, 'Save Teams app package').click());
    await settle();

    expect(el.textContent).toContain('Could not save the Teams app package.');
  });
});

describe('closing while a request is in flight', () => {
  it('disables Close during an add/remove/make-default call, and re-enables it after', async () => {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [team({ hasSwitch: false, isDefault: false })],
      defaultTeamId: null,
      inCatalog: true,
      catalogProblem: null,
    });
    const { promise, resolve } = deferred<{ kind: 'added' }>();
    addBridgeTeam.mockReturnValue(promise);
    const el = await render();

    await act(async () => button(el, 'Add').click());
    await settle();

    expect(button(el, 'Close').disabled).toBe(true);

    await act(async () => resolve({ kind: 'added' }));
    await settle();

    expect(button(el, 'Close').disabled).toBe(false);
  });

  it('disables Close while the package save is in flight, and re-enables it after', async () => {
    listBridgeTeams.mockResolvedValue({
      kind: 'listed',
      teams: [],
      defaultTeamId: null,
      inCatalog: false,
      catalogProblem: null,
    });
    const { promise, resolve } = deferred<string | null>();
    downloadTeamsPackage.mockReturnValue(promise);
    const el = await render();

    await act(async () => button(el, 'Save Teams app package').click());
    await settle();

    expect(button(el, 'Close').disabled).toBe(true);

    await act(async () => resolve(null));
    await settle();

    expect(button(el, 'Close').disabled).toBe(false);
  });
});
