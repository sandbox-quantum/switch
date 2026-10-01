import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';

const state = vi.hoisted(() => ({
  inScope: null as Workspace | null,
  noMembership: false,
}));

vi.mock('./workspaces-store', () => ({
  workspacesStore: {
    onServerInScope: () => state.inScope,
    hasNoMembership: () => state.noMembership,
  },
}));

const { workspaceTitle } = await import('./workspace-title');

const server = { id: 'srv-1', name: 'Switch Cloud' } as SwitchServer;

function workspace(name: string, tenantId: string | null): Workspace {
  return {
    id: 'ws-1',
    serverId: 'srv-1',
    name,
    tenantId,
    slug: null,
    role: null,
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  state.inScope = null;
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
