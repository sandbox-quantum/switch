import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireWorkspace = vi.hoisted(() => vi.fn());
const fetchInvitations = vi.hoisted(() => vi.fn());
const fetchInviteEmailEnabled = vi.hoisted(() => vi.fn());
const createInvitation = vi.hoisted(() => vi.fn());
const revokeInvitation = vi.hoisted(() => vi.fn());
const leased = vi.hoisted(() => [] as string[]);

const SERVER = vi.hoisted(() => ({
  id: 'srv-1',
  name: 'switch.example.com',
  url: 'https://switch.example.com/',
  dashboardUrl: null as string | null,
}));

vi.mock('./workspaces-store', () => ({ requireWorkspace }));
vi.mock('./workspace-session', () => ({
  withReachableWorkspaceSession: (workspaceId: string, fn: (server: unknown) => unknown) => {
    leased.push(workspaceId);
    return fn(SERVER);
  },
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchInvitations,
  fetchInviteEmailEnabled,
  createInvitation,
  revokeInvitation,
}));

import {
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from './invitations';

const INVITATION = {
  id: 'inv-1',
  role: 'member',
  email: null,
  expiresAt: '2026-10-05T00:00:00.000Z',
  usesRemaining: 1,
  revokedAt: null,
  createdAt: '2026-09-28T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  leased.length = 0;
  requireWorkspace.mockResolvedValue({ id: 'ws-1', name: 'Acme', tenantId: 'tenant-1' });
});

describe('workspace invitations', () => {
  it('lists them for the workspace tenant, with whether e-mail is on', async () => {
    fetchInvitations.mockResolvedValue([INVITATION]);
    fetchInviteEmailEnabled.mockResolvedValue(true);

    await expect(listWorkspaceInvitations('ws-1')).resolves.toEqual({
      invitations: [INVITATION],
      emailEnabled: true,
    });
    expect(fetchInvitations).toHaveBeenCalledWith(SERVER, 'tenant-1');
    expect(leased).toEqual(['ws-1']);
  });

  it('hands back the link built from the server’s address, never the bare token', async () => {
    createInvitation.mockResolvedValue({
      invitation: INVITATION,
      token: 'a+b/c',
      emailDelivery: 'not_requested',
    });

    const created = await createWorkspaceInvitation({
      workspaceId: 'ws-1',
      role: 'member',
      email: null,
      expiresInHours: 168,
      usesRemaining: 1,
    });

    expect(createInvitation).toHaveBeenCalledWith(SERVER, 'tenant-1', {
      role: 'member',
      email: null,
      expiresInHours: 168,
      usesRemaining: 1,
    });
    expect(created).toEqual({
      invitation: INVITATION,
      link: 'https://switch.example.com/invite#token=a%2Bb%2Fc',
      emailDelivery: 'not_requested',
    });
  });

  it('builds the link on the dashboard address an older server keeps apart', async () => {
    createInvitation.mockResolvedValue({
      invitation: INVITATION,
      token: 'tok',
      emailDelivery: 'not_requested',
    });
    SERVER.dashboardUrl = 'https://switch-gateway.example.com';
    try {
      const created = await createWorkspaceInvitation({
        workspaceId: 'ws-1',
        role: 'member',
        email: null,
        expiresInHours: 168,
        usesRemaining: 1,
      });
      expect(created.link).toBe('https://switch-gateway.example.com/invite#token=tok');
    } finally {
      SERVER.dashboardUrl = null;
    }
  });

  it('revokes one by id on the workspace tenant', async () => {
    revokeInvitation.mockResolvedValue({ ...INVITATION, revokedAt: '2026-09-28T01:00:00.000Z' });

    await revokeWorkspaceInvitation({ workspaceId: 'ws-1', invitationId: 'inv-1' });

    expect(revokeInvitation).toHaveBeenCalledWith(SERVER, 'tenant-1', 'inv-1');
  });

  it('refuses a workspace not matched to a tenant, before touching the server', async () => {
    requireWorkspace.mockResolvedValue({ id: 'ws-1', name: 'Acme', tenantId: null });

    await expect(listWorkspaceInvitations('ws-1')).rejects.toThrow(/not matched/);
    expect(leased).toEqual([]);
    expect(fetchInvitations).not.toHaveBeenCalled();
  });
});
