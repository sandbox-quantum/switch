import { beforeEach, describe, expect, it, vi } from 'vitest';

const onServerInScope = vi.hoisted(() => vi.fn());
const statusFor = vi.hoisted(() => vi.fn());

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { onServerInScope },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { statusFor },
}));

import { administersWorkspaceInScope } from '@renderer/features/switch-servers/workspace-admin';

function signedInAs(role: 'admin' | 'user') {
  statusFor.mockReturnValue({ user: { id: 'u-1', role } });
}

function inWorkspaceAs(role: 'owner' | 'admin' | 'member' | null) {
  onServerInScope.mockReturnValue({ id: 'ws-1', tenantId: 't-1', role });
}

describe('administersWorkspaceInScope', () => {
  beforeEach(() => {
    onServerInScope.mockReset().mockReturnValue(null);
    statusFor.mockReset().mockReturnValue(undefined);
  });

  it('lets an owner or admin of the workspace manage it', () => {
    signedInAs('user');
    inWorkspaceAs('owner');
    expect(administersWorkspaceInScope('srv-1')).toBe(true);
    inWorkspaceAs('admin');
    expect(administersWorkspaceInScope('srv-1')).toBe(true);
  });

  it('does not let a plain member manage it', () => {
    signedInAs('user');
    inWorkspaceAs('member');
    expect(administersWorkspaceInScope('srv-1')).toBe(false);
  });

  it('does not let an account whose membership was withdrawn manage it', () => {
    signedInAs('user');
    inWorkspaceAs(null);
    expect(administersWorkspaceInScope('srv-1')).toBe(false);
  });

  it('lets the operator running the server manage any workspace', () => {
    signedInAs('admin');
    inWorkspaceAs('member');
    expect(administersWorkspaceInScope('srv-1')).toBe(true);
  });

  it('says no while there is no workspace to act in', () => {
    signedInAs('user');
    expect(administersWorkspaceInScope('srv-1')).toBe(false);
  });
});
