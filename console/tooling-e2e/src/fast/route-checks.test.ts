import { describe, expect, it } from 'vitest';
import type { AgentRef, RoomDetail } from '../clients/switch-client.ts';
import { crossTenantPath, probeOrder, type OtherTenant } from './cross-tenant.ts';
import { isHtml, probeSessionRoutes } from './session-required.ts';
import type { SwitchClient } from '../clients/switch-client.ts';
import type { ServerSurface } from '../gate/gate.ts';

const OTHER: OtherTenant = {
  tenantId: 't-1',
  room: { id: 'r-1' } as RoomDetail,
  agent: { id: 'a-1', name: 'e2e-abc123a-theirs' } as AgentRef,
};

describe('crossTenantPath', () => {
  it("fills every parameter with the other workspace's values", () => {
    expect(crossTenantPath('GET /gateway/rooms/{room_id}', OTHER)).toEqual({
      method: 'GET',
      path: '/gateway/rooms/r-1',
    });
    expect(crossTenantPath('DELETE /gateway/rooms/{room_id}/agents/{agent_id}', OTHER)).toEqual({
      method: 'DELETE',
      path: '/gateway/rooms/r-1/agents/a-1',
    });
    expect(crossTenantPath('GET /gateway/tenants/{tenant_id}', OTHER)?.path).toBe(
      '/gateway/tenants/t-1'
    );
  });

  it('skips a route with a parameter the other workspace has nothing for', () => {
    expect(crossTenantPath('GET /gateway/rooms/{room_id}/tasks/{task_id}', OTHER)).toBeNull();
  });

  it('skips a route without parameters', () => {
    expect(crossTenantPath('GET /gateway/rooms', OTHER)).toBeNull();
  });
});

describe('probeOrder', () => {
  it('puts reads first, then every write, then deletes', () => {
    const routes = [
      'DELETE /gateway/rooms/{room_id}',
      'POST /gateway/rooms/{room_id}/archive',
      'GET /gateway/rooms/{room_id}',
      'PATCH /gateway/rooms/{room_id}',
      'PUT /gateway/tenants/{tenant_id}/members/{user_id}',
      'GET /gateway/agents/{agent_id}',
    ];
    expect(routes.toSorted((a, b) => probeOrder(a) - probeOrder(b))).toEqual([
      'GET /gateway/rooms/{room_id}',
      'GET /gateway/agents/{agent_id}',
      'POST /gateway/rooms/{room_id}/archive',
      'PATCH /gateway/rooms/{room_id}',
      'PUT /gateway/tenants/{tenant_id}/members/{user_id}',
      'DELETE /gateway/rooms/{room_id}',
    ]);
  });
});

describe('isHtml', () => {
  it('tells a web page from an API answer', () => {
    expect(isHtml('text/html; charset=utf-8')).toBe(true);
    expect(isHtml('Text/HTML')).toBe(true);
    expect(isHtml('application/json')).toBe(false);
    expect(isHtml('')).toBe(false);
  });
});

describe('probeSessionRoutes', () => {
  // A hosted agents v2 route answers 404 with v2 off, before any session check,
  // as a route that doesn't exist; `/feature-flags` lists `hosted_v2` only with v2 on.
  const surface = {
    operations: [],
    gatewayRoutes: [
      { route: 'GET /gateway/rooms', auth: 'session', flags: [] },
      { route: 'GET /gateway/shared-cloud/overview', auth: 'session', flags: ['hosted_v2'] },
    ],
  } as unknown as ServerSurface;

  function client(flags: string[], v2On: boolean): SwitchClient {
    return {
      enabledFeatureFlags: async () => new Set(flags),
      statusWithoutCredentials: async (_method: string, path: string) =>
        path.includes('shared-cloud') && !v2On
          ? { status: 404, contentType: 'application/json' }
          : { status: 401, contentType: 'application/json' },
    } as unknown as SwitchClient;
  }

  it("counts a route behind hosted_v2 as not mounted when the server doesn't list it", async () => {
    expect(await probeSessionRoutes(client([], false), surface)).toEqual({
      probed: 1,
      notMounted: 1,
      wrong: [],
    });
  });

  it('probes it, and expects the 401, when the server lists hosted_v2 as on', async () => {
    expect(await probeSessionRoutes(client(['hosted_v2'], true), surface)).toEqual({
      probed: 2,
      notMounted: 0,
      wrong: [],
    });
  });
});
