import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';

const state = vi.hoisted(() => ({
  inScope: null as Workspace | null,
  onServer: [] as Workspace[],
  noMembership: false,
}));

vi.mock('./workspaces-store', () => ({
  workspacesStore: {
    onServerInScope: () => state.inScope,
    onServer: () => state.onServer,
    hasNoMembership: () => state.noMembership,
  },
}));

const { breadcrumbTitle, workspaceDisplayName, workspaceTitle } = await import('./workspace-title');

const server = { id: 'srv-1', name: 'Switch Cloud' } as SwitchServer;

const local = { id: 'srv-1', name: 'Local Switch server' } as SwitchServer;

function workspace(name: string, tenantId: string | null, slug: string | null = null): Workspace {
  return {
    id: 'ws-1',
    serverId: 'srv-1',
    name,
    tenantId,
    slug,
    role: null,
    organizationId: null,
    organizationName: null,
    organizationRole: null,
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  state.inScope = null;
  state.onServer = [];
  state.noMembership = false;
});

describe('what a server page is titled', () => {
  it("is the workspace's name once it is matched", () => {
    state.inScope = workspace('SandboxAQ', 't-1');
    expect(workspaceTitle(server)).toBe('SandboxAQ');
  });

  it("is the server's name for the placeholder before sign-in", () => {
    state.inScope = workspace('Switch Cloud', null);
    expect(workspaceTitle(server)).toBe('Switch Cloud');
  });

  it('says there is no workspace when the account belongs to none', () => {
    state.inScope = workspace('Switch Cloud', null);
    state.noMembership = true;
    expect(workspaceTitle(server)).toBe('No workspace yet');
  });
});

describe('what a workspace is called where the Console says where you are', () => {
  const builtIn = workspace('Default', 't-0', 'default');

  it("is the server's name for a server's built-in workspace when it is the only one", () => {
    state.onServer = [builtIn];
    expect(workspaceDisplayName(builtIn, local)).toBe('Local Switch server');
  });

  it("roots that server's breadcrumb at the server, and leaves the page title alone", () => {
    state.inScope = builtIn;
    state.onServer = [builtIn];
    expect(breadcrumbTitle(local)).toBe('Local Switch server');
    expect(workspaceTitle(local)).toBe('Default');
  });

  it('keeps "Default" beside other workspaces on the same server', () => {
    state.onServer = [builtIn, { ...workspace('Acme', 't-2', 'acme'), id: 'ws-2' }];
    expect(workspaceDisplayName(builtIn, local)).toBe('Default');
  });

  it('keeps a named workspace its own name, even when it is the only one', () => {
    const named = workspace('SandboxAQ', 't-1', 'sandboxaq');
    state.onServer = [named];
    expect(workspaceDisplayName(named, server)).toBe('SandboxAQ');
  });

  it('keeps "Default" when the server has no name to give', () => {
    state.onServer = [builtIn];
    expect(workspaceDisplayName(builtIn, { ...local, name: '  ' })).toBe('Default');
  });
});
