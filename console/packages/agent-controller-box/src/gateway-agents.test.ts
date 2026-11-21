import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRelayCredentials } from './controller';
import {
  type GatewayDeps,
  gatewayEnvironment,
  gatewayProbe,
  resolveGateway,
} from './gateway-agents';
import { VertexTokenCache } from './gateway-logins';
import { silentLogger } from './log';
import { ProviderGateway } from './provider-gateway';
import type { LocalRelay } from './relay';
import type { GivenLogin } from './sealed-logins';
import { FakeRuntime } from './testing/fake-runtime';
import { standInSend } from './testing/stand-in-upstream';
import { VertexTokens } from './vertex-tokens';

const AGENT = 'agent-1';

function given(revision: string, fields: Partial<GivenLogin> = {}): GivenLogin {
  return {
    status: 'connected',
    provider: 'claude',
    revision,
    kind: 'api-key',
    credential: `sk-ant-api03-REAL-${revision}`,
    ...fields,
  } as GivenLogin;
}

function fakeRelay(): LocalRelay {
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

/** A stand-in provider that records the key each call carried. */
let upstream: Server;
let upstreamUrl: string;
let seen: IncomingHttpHeaders[];

let runtime: FakeRuntime;
let relay: LocalRelay;
let deps: GatewayDeps;

async function startGateway(): Promise<GatewayDeps> {
  // The gateway calls the real provider URL; the stand-in answers it.
  const gateway = new ProviderGateway({ log: silentLogger, send: standInSend(() => upstreamUrl) });
  await gateway.start();
  gateway.setReady();
  return { gateway, vertex: new VertexTokenCache() };
}

/** Calls the gateway as the agent's CLI would; resolves with the status. */
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
  runtime = new FakeRuntime();
  relay = fakeRelay();
  deps = await startGateway();
});

afterEach(async () => {
  await deps.gateway.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const ensure = (login: GivenLogin | null, gw: GatewayDeps = deps) =>
  ensureRelayCredentials(AGENT, login, { runtime, relay, log: silentLogger, gateway: gw });

describe('a gateway-backed login', () => {
  it('is never written to the credentials file: only the opaque token is', async () => {
    await ensure(null);
    expect(await ensure(given('1'))).toBe('login');
    const file = runtime.credentials.get(AGENT)!;
    expect(file.providerLogin).toBeNull();
    expect(file.gateway).toMatchObject({ provider: 'claude', kind: 'api-key', revision: '1' });
    expect(file.gateway!.token.startsWith('swpg_')).toBe(true);
    expect(JSON.stringify(file)).not.toContain('REAL');
    // The token works, and the provider sees the real key.
    expect(await callAs(deps, file.gateway!.token)).toBe(200);
    expect(seen[0]!['x-api-key']).toBe('sk-ant-api03-REAL-1');
  });

  it('a new revision of the same kind is swapped in the gateway: same token, no restart', async () => {
    await ensure(given('1'));
    const token = runtime.credentials.get(AGENT)!.gateway!.token;
    expect(await ensure(given('2'))).toBe(false);
    expect(runtime.credentials.get(AGENT)!.gateway).toMatchObject({ token, revision: '2' });
    expect(await callAs(deps, token)).toBe(200);
    expect(seen.at(-1)!['x-api-key']).toBe('sk-ant-api03-REAL-2');
    expect(await ensure(given('2'))).toBe(false);
  });

  it('another kind of login gets a new token, and the host restarts for it', async () => {
    await ensure(given('1'));
    const old = runtime.credentials.get(AGENT)!.gateway!.token;
    expect(await ensure(given('2', { kind: 'setup-token', credential: 'sk-ant-oat01-REAL' }))).toBe(
      'login'
    );
    const record = runtime.credentials.get(AGENT)!.gateway!;
    expect(record.kind).toBe('setup-token');
    expect(record.token).not.toBe(old);
    expect(await callAs(deps, old)).toBe(401);
  });

  it('withdrawn: the token stops working at once, and the host restarts unasked', async () => {
    await ensure(given('1'));
    const token = runtime.credentials.get(AGENT)!.gateway!.token;
    expect(await ensure(null)).toBe('withdrawn');
    expect(runtime.credentials.get(AGENT)!.gateway).toBeUndefined();
    expect(runtime.credentials.get(AGENT)!.providerLogin).toBeNull();
    expect(await callAs(deps, token)).toBe(401);
  });

  it('a token saved before a controller restart is honoured again, so a running host keeps working', async () => {
    await ensure(given('1'));
    const token = runtime.credentials.get(AGENT)!.gateway!.token;
    // The controller restarts: a new gateway, with no agents.
    await deps.gateway.close();
    deps = await startGateway();
    expect(await callAs(deps, token)).toBe(401);
    expect(await ensure(given('1'))).toBe(false);
    expect(await callAs(deps, token)).toBe(200);
  });
});

describe('a login the gateway can’t front', () => {
  it('isn’t handed to the agent at all: no plaintext login in the file, and no token', async () => {
    const cursor = given('1', { provider: 'cursor', kind: 'api-key', credential: 'cursor-key' });
    await ensure(null);
    await ensure(cursor);
    const file = runtime.credentials.get(AGENT)!;
    expect(file.providerLogin).toBeNull();
    expect(file.gateway).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain('cursor-key');
  });

  it('moving from a gateway-backed login to one it can’t front withdraws: the token stops at once', async () => {
    await ensure(given('1'));
    const token = runtime.credentials.get(AGENT)!.gateway!.token;
    const cursor = given('2', { provider: 'cursor', kind: 'api-key', credential: 'cursor-key' });
    expect(await ensure(cursor)).toBe('withdrawn');
    expect(await callAs(deps, token)).toBe(401);
    expect(runtime.credentials.get(AGENT)!.gateway).toBeUndefined();
    expect(runtime.credentials.get(AGENT)!.providerLogin).toBeNull();
  });
});

describe('the CLI environment', () => {
  it('names the gateway and the saved token, never the login', async () => {
    await ensure(given('1'));
    const record = runtime.credentials.get(AGENT)!.gateway!;
    const env = gatewayEnvironment(given('1'), record, deps)!;
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: deps.gateway.endpoint,
      ANTHROPIC_API_KEY: record.token,
    });
    expect(JSON.stringify(env)).not.toContain('REAL');
  });

  it('is null when the record is for another kind of login, or missing', async () => {
    await ensure(given('1'));
    const record = runtime.credentials.get(AGENT)!.gateway!;
    expect(gatewayEnvironment(given('1', { kind: 'setup-token' }), record, deps)).toBeNull();
    expect(gatewayEnvironment(given('1'), null, deps)).toBeNull();
  });
});

describe('a probe of a login', () => {
  it('runs through the gateway with a short-lived token, never the login, and stops when done', async () => {
    const probe = gatewayProbe('probe-1', given('1'), deps)!;
    expect(JSON.stringify(probe.env)).not.toContain('REAL');
    const token = probe.env.ANTHROPIC_API_KEY!;
    expect(token.startsWith('swpg_')).toBe(true);
    expect(probe.env.ANTHROPIC_BASE_URL).toBe(deps.gateway.endpoint);
    expect(await callAs(deps, token)).toBe(200);
    expect(seen[0]!['x-api-key']).toBe('sk-ant-api03-REAL-1');
    // A probe is not an agent: the agent count and the agent's own token are untouched.
    expect(deps.gateway.counts().agents).toBe(0);
    probe.done();
    probe.done();
    expect(await callAs(deps, token)).toBe(401);
    expect(deps.gateway.probes()).toBe(0);
  });

  it('is null for a login the gateway can’t front', () => {
    const cursor = given('1', { provider: 'cursor', kind: 'api-key', credential: 'cursor-key' });
    expect(gatewayProbe('probe-2', cursor, deps)).toBeNull();
    expect(deps.gateway.probes()).toBe(0);
  });
});

describe('a withdrawn Vertex login', () => {
  // Made-up values only, and a neutral project name.
  const VERTEX = JSON.stringify({
    v: 1,
    project: 'example-project',
    region: 'global',
    credentials: {
      type: 'authorized_user',
      client_id: 'c.apps.googleusercontent.com',
      client_secret: 's',
      refresh_token: 'r',
    },
  });

  it("leaves no cached Google tokens behind: the next login's tokens are made afresh", async () => {
    let made = 0;
    const vertex = new VertexTokenCache(() => {
      made += 1;
      return new VertexTokens(
        {
          type: 'authorized_user',
          client_id: 'c',
          client_secret: 's',
          refresh_token: 'r',
        } as never,
        { post: async () => ({ status: 200, body: { access_token: 'ya29.T', expires_in: 3600 } }) }
      );
    });
    const gw = new ProviderGateway({
      log: silentLogger,
      send: standInSend(() => 'http://127.0.0.1:1'),
    });
    const vertexDeps: GatewayDeps = { gateway: gw, vertex };
    const login = given('1', { kind: 'vertex', credential: VERTEX });
    const first = resolveGateway(AGENT, login, null, vertexDeps);
    expect(made).toBe(1);
    // The same revision again reuses the cache.
    resolveGateway(AGENT, login, first.record, vertexDeps);
    expect(made).toBe(1);
    // Withdrawn: the agent's route goes, and so do the cached tokens holding the opened login.
    expect(resolveGateway(AGENT, null, first.record, vertexDeps).change).toBe('withdrawn');
    vertex.for(login);
    expect(made).toBe(2);
  });
});
