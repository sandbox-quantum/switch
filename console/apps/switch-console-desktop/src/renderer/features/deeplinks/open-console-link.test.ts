import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.hoisted(() => vi.fn());
const showModal = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
const administers = vi.hoisted(() => vi.fn(() => true));
const servers = vi.hoisted(() => ({
  activeServerId: 'srv-1' as string | null,
  servers: [
    { id: 'srv-1', url: 'http://localhost:8000', dashboardUrl: null, managed: true },
    { id: 'srv-2', url: 'https://switch.example.com', dashboardUrl: null, managed: false },
    {
      id: 'srv-3',
      url: 'https://old-api.example.com',
      dashboardUrl: 'https://old.example.com',
      managed: false,
    },
  ],
  setActive: vi.fn(async (id: string) => {
    servers.activeServerId = id;
  }),
}));

vi.mock('sonner', () => ({ toast: { error: toastError } }));
// A method that needs its store, as the real one does: called detached, it throws.
const navigation = vi.hoisted(() => ({
  navigate(this: unknown, ...args: unknown[]) {
    if (this !== navigation) throw new Error('navigate was called without its store');
    navigate(...args);
  },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation } }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { managedAgents: { list } } }));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: servers,
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: administers,
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws-1' },
}));

const { openConsoleLink } = await import('./open-console-link');

beforeEach(() => {
  vi.clearAllMocks();
  servers.activeServerId = 'srv-1';
});

describe('openConsoleLink', () => {
  it('opens a page on the server on screen', async () => {
    await openConsoleLink('switchdash://open/rooms');
    expect(navigate).toHaveBeenCalledWith('serverRooms', { serverId: 'srv-1' });
  });

  it('opens the Server page of a server this Console runs', async () => {
    await openConsoleLink('switchdash://open/server');
    expect(navigate).toHaveBeenCalledWith('managedServer', { serverId: 'srv-1' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('opens the home of a server someone else runs, and says it has no Server page', async () => {
    await openConsoleLink('switchdash://open/server?server=https%3A%2F%2Fswitch.example.com');
    expect(navigate).toHaveBeenCalledWith('server', { serverId: 'srv-2' });
    expect(navigate).not.toHaveBeenCalledWith('managedServer', expect.anything());
    expect(toastError).toHaveBeenCalledWith(
      'This server has no Server page here',
      expect.anything()
    );
  });

  it('opens Admin on the section its tab names', async () => {
    await openConsoleLink('switchdash://open/admin?tab=apps');
    expect(navigate).toHaveBeenCalledWith('admin', { serverId: 'srv-1', section: 'apps' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('opens the home for someone who does not administer the workspace, and says why', async () => {
    administers.mockReturnValueOnce(false);
    await openConsoleLink('switchdash://open/admin?server=https%3A%2F%2Fswitch.example.com');
    expect(navigate).toHaveBeenCalledWith('server', { serverId: 'srv-2' });
    expect(navigate).not.toHaveBeenCalledWith('admin', expect.anything());
    expect(toastError).toHaveBeenCalledWith('Admin is for workspace admins', expect.anything());
  });

  it('opens the Status page for someone who runs the server without administering it', async () => {
    administers.mockReturnValueOnce(false);
    await openConsoleLink('switchdash://open/admin');
    expect(navigate).toHaveBeenCalledWith('managedServer', { serverId: 'srv-1' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('opens a dialog over the page it belongs to', async () => {
    await openConsoleLink('switchdash://open/messaging-apps/connect');
    expect(navigate).toHaveBeenCalledWith('server', { serverId: 'srv-1' });
    expect(showModal).toHaveBeenCalledWith(
      'connectMessagingAppModal',
      expect.objectContaining({ serverId: 'srv-1' })
    );
    await openConsoleLink('switchdash://open/invite');
    expect(showModal).toHaveBeenCalledWith('invitePeopleModal', { workspaceId: 'ws-1' });
  });

  it('opens an agent on the section its tab names', async () => {
    list.mockResolvedValueOnce([{ agentId: 'a-1', name: 'switch-buddy-ada' }]);
    await openConsoleLink('switchdash://open/agent/a-1?tab=settings');
    expect(navigate).toHaveBeenCalledWith('managedAgent', {
      serverId: 'srv-1',
      agentId: 'a-1',
      name: 'switch-buddy-ada',
      section: 'settings',
    });
  });

  it('opens an agent on its chat for the Chats tab', async () => {
    list.mockResolvedValueOnce([{ agentId: 'a-1', name: 'reviewer' }]);
    await openConsoleLink('switchdash://open/agent/a-1?tab=chats');
    expect(navigate).toHaveBeenCalledWith('managedAgent', {
      serverId: 'srv-1',
      agentId: 'a-1',
      name: 'reviewer',
    });
  });

  it('says so for an agent that has no page here', async () => {
    list.mockResolvedValueOnce([]);
    await openConsoleLink('switchdash://open/agent/someone-elses');
    expect(navigate).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it("opens switch-buddy's own page on the tab the link names", async () => {
    list.mockResolvedValueOnce([
      { agentId: 'a-1', name: 'reviewer' },
      { agentId: 'b-1', name: 'switch-buddy-ada' },
    ]);
    await openConsoleLink('switchdash://open/buddy?tab=connections');
    expect(navigate).toHaveBeenCalledWith('managedAgent', {
      serverId: 'srv-1',
      agentId: 'b-1',
      name: 'switch-buddy-ada',
      section: 'connections',
    });
  });

  it('switches to the server a link names', async () => {
    list.mockResolvedValueOnce([]);
    await openConsoleLink('switchdash://open/buddy?server=https%3A%2F%2Fswitch.example.com%2F');
    expect(servers.setActive).toHaveBeenCalledWith('srv-2');
    expect(navigate).toHaveBeenCalledWith('switchBuddy', { serverId: 'srv-2' });
  });

  it('knows an older server by the separate host its dashboard is on', async () => {
    await openConsoleLink('switchdash://open/rooms?server=https%3A%2F%2Fold.example.com');
    expect(servers.setActive).toHaveBeenCalledWith('srv-3');
    expect(navigate).toHaveBeenCalledWith('serverRooms', { serverId: 'srv-3' });
  });

  it('refuses a server it is not connected to, and a malformed link', async () => {
    await openConsoleLink('switchdash://open/home?server=https%3A%2F%2Felsewhere.test');
    await openConsoleLink('switchdash://open/nowhere');
    expect(navigate).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(2);
  });

  it('opens settings without a server', async () => {
    servers.activeServerId = null;
    await openConsoleLink('switchdash://open/settings?tab=clis-models');
    expect(navigate).toHaveBeenCalledWith('settings', { tab: 'clis-models' });
  });
});
