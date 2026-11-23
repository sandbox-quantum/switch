import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRelayCredentials } from './controller';
import type { GatewayDeps } from './gateway-agents';
import { VertexTokenCache } from './gateway-logins';
import { HostTickets } from './host-tickets';
import { LauncherRunner } from './launcher-runner';
import { silentLogger } from './log';
import { OwnerMarkers } from './owner-marker';
import { dataLayout } from './paths';
import { ProviderGateway } from './provider-gateway';
import type { LocalRelay } from './relay';
import type { GivenLogin } from './sealed-logins';
import { SplitRuntime } from './split-runtime';
import { standInSend } from './testing/stand-in-upstream';

/**
 * The restart case on a split box: the controller's own copy
 * of each agent's credentials (on its own disk, through `SplitRuntime`) keeps
 * the whole gateway record, so after a controller restart the saved token is
 * registered again and a host that outlived the restart keeps working.
 */

const AGENT = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
let dir: string;
let upstream: Server;
let upstreamUrl: string;
let seen: IncomingHttpHeaders[];
let deps: GatewayDeps;

const given = (revision: string): GivenLogin =>
  ({
    status: 'connected',
    provider: 'claude',
    revision,
    kind: 'api-key',
    credential: `sk-ant-api03-REAL-${revision}`,
  }) as GivenLogin;

function relay(): LocalRelay {
  const registered = new Map<string, string>();
  let minted = 0;
  return {
    endpoint: 'http://127.0.0.1:43210',
    hubUrl: 'ws://127.0.0.1:43210/hub',
    isRegistered: (agentId: string, token: string) => registered.get(agentId) === token,
    register: (agentId: string, token: string) => void registered.set(agentId, token),
    mint: (agentId: string) => {
      const token = `swlr_${++minted}`;
      registered.set(agentId, token);
      return token;
    },
  } as unknown as LocalRelay;
}

/** A controller's split runtime over its own disk in `dir`, as after a (re)start. */
function splitRuntime(): SplitRuntime {
  const link = { order: async () => ({ kind: 'reply' as const, id: 1, ok: true }) };
  let made: SplitRuntime | null = null;
  made = new SplitRuntime({
    runner: new LauncherRunner({
      link,
      tickets: new HostTickets(),
      markers: new OwnerMarkers(Buffer.alloc(32, 1)),
      credentials: (agentId) => made?.credentialsFor(agentId) ?? null,
    }),
    link,
    store: dataLayout(join(dir, 'controller')),
    agents: dataLayout('/data/agents'),
    workspaces: '/data/agents/workspaces',
  });
  return made;
}

async function startGateway(): Promise<GatewayDeps> {
  const gateway = new ProviderGateway({ log: silentLogger, send: standInSend(() => upstreamUrl) });
  await gateway.start();
  gateway.setReady();
  return { gateway, vertex: new VertexTokenCache() };
}

function callAs(gw: GatewayDeps, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${gw.gateway.endpoint}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'split-gateway-'));
  seen = [];
  upstream = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  deps = await startGateway();
});

afterEach(async () => {
  await deps.gateway.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('the gateway record on a split box', () => {
  it('is kept whole in the controller’s own copy, so a saved token is honoured after a controller restart', async () => {
    const before = splitRuntime();
    const r = relay();
    await ensureRelayCredentials(AGENT, given('1'), {
      runtime: before,
      relay: r,
      log: silentLogger,
      gateway: deps,
    });
    const saved = await before.readCredentials(AGENT);
    expect(saved?.gateway).toMatchObject({ provider: 'claude', kind: 'api-key', revision: '1' });
    expect(saved?.providerLogin).toBeNull();
    const token = saved!.gateway!.token;
    expect(await callAs(deps, token)).toBe(200);

    // The controller restarts: a new gateway with no agents, and a new runtime
    // reading its own disk afresh.
    await deps.gateway.close();
    deps = await startGateway();
    expect(await callAs(deps, token)).toBe(401);
    const after = splitRuntime();
    expect(
      await ensureRelayCredentials(AGENT, given('1'), {
        runtime: after,
        relay: r,
        log: silentLogger,
        gateway: deps,
      })
    ).toBe(false);
    // The same token works again, without a host restart; the provider sees the real key.
    expect((await after.readCredentials(AGENT))?.gateway?.token).toBe(token);
    expect(await callAs(deps, token)).toBe(200);
    expect(seen.at(-1)!['x-api-key']).toBe('sk-ant-api03-REAL-1');
  });
});
