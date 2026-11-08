import { beforeEach, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const gatewayFetch = vi.hoisted(() => vi.fn());
const GatewayError = vi.hoisted(
  () =>
    class GatewayError extends Error {
      constructor(readonly status: number) {
        super('Gateway request failed');
      }
    }
);
vi.mock('./gateway-client', () => ({ gatewayFetch, GatewayError }));

const { dismissOwnerNotice, fetchOwnerNotices } = await import('./owner-notices');
const server = { id: 'server' } as SwitchServer;

beforeEach(() => gatewayFetch.mockReset());

it('reads authenticated notices and maps the gateway response', async () => {
  gatewayFetch.mockResolvedValue({
    json: async () => [
      {
        id: 'notice',
        kind: 'unverified_agent_invite',
        owner_id: 'owner',
        tenant_id: 'tenant',
        agent_name: 'Agent',
        room_name: 'Room',
        created_at: '2026-11-08T00:00:00Z',
      },
    ],
  });
  await expect(fetchOwnerNotices(server, 'owner', 'tenant')).resolves.toEqual({
    supported: true,
    notices: [
      {
        id: 'notice',
        kind: 'unverified_agent_invite',
        agentName: 'Agent',
        roomName: 'Room',
        createdAt: '2026-11-08T00:00:00Z',
      },
    ],
  });
  expect(gatewayFetch).toHaveBeenCalledWith(server, '/owner-notices', { authenticated: true });
});

it('distinguishes an older gateway from other failures', async () => {
  gatewayFetch.mockRejectedValueOnce(new GatewayError(404));
  await expect(fetchOwnerNotices(server, 'owner', 'tenant')).resolves.toEqual({ supported: false });
  gatewayFetch.mockRejectedValueOnce(new GatewayError(403));
  await expect(fetchOwnerNotices(server, 'owner', 'tenant')).rejects.toThrow(
    'Gateway request failed'
  );
});

it('rejects malformed notice data rather than displaying it as a valid notice', async () => {
  gatewayFetch.mockResolvedValue({ json: async () => [{ id: 'notice' }] });
  await expect(fetchOwnerNotices(server, 'owner', 'tenant')).rejects.toThrow();
});

it('rejects notices if the authenticated owner changed during the request', async () => {
  gatewayFetch.mockResolvedValue({
    json: async () => [
      {
        id: 'notice',
        kind: 'unverified_agent_invite',
        owner_id: 'another-owner',
        tenant_id: 'tenant',
        agent_name: 'Agent',
        room_name: 'Room',
        created_at: '2026-11-08T00:00:00Z',
      },
    ],
  });
  await expect(fetchOwnerNotices(server, 'owner', 'tenant')).rejects.toThrow(
    'account or workspace changed'
  );
});

it('rejects notices if the gateway selected a different workspace', async () => {
  gatewayFetch.mockResolvedValue({
    json: async () => [
      {
        id: 'notice',
        kind: 'unverified_agent_invite',
        owner_id: 'owner',
        tenant_id: 'another-tenant',
        agent_name: 'Agent',
        room_name: 'Room',
        created_at: '2026-11-08T00:00:00Z',
      },
    ],
  });
  await expect(fetchOwnerNotices(server, 'owner', 'tenant')).rejects.toThrow('workspace changed');
});

it('dismisses only the requested encoded notice through the authenticated gateway', async () => {
  gatewayFetch.mockResolvedValue({});
  await dismissOwnerNotice(server, 'one/two');
  expect(gatewayFetch).toHaveBeenCalledWith(server, '/owner-notices/one%2Ftwo', {
    authenticated: true,
    method: 'DELETE',
  });
});
