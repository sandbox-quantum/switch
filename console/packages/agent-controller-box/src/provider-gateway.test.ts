import {
  createServer,
  type IncomingHttpHeaders,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DailyCallCap } from './gateway-usage';
import type { Logger } from './log';
import {
  baseUrlWithToken,
  GATEWAY_TOKEN_PREFIX,
  PROBE_LIFETIME_MS,
  PROBE_MAX_CALLS,
  type GatewayDeps,
  type GatewayRoute,
  ProviderGateway,
} from './provider-gateway';
import { standInSend } from './testing/stand-in-upstream';

/** A stand-in provider: records what reached it and answers as each test says. */
class Upstream {
  server: Server | null = null;
  url = '';
  seen: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  respond: (res: ServerResponse) => void | Promise<void> = (res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=1' });
    res.end('{"ok":true}');
  };

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.seen.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        void this.respond(res);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

type Call = { status: number; headers: IncomingHttpHeaders; body: string; firstChunkAt: number };

function call(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Call> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = request(`${base}${path}`, {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      // A fresh connection for every call. With Node's shared keep-alive agent, a call could
      // be sent on a socket the gateway had just closed after the last one, which under load
      // (as in CI) surfaces as a one-off "socket hang up" rather than the answer under test.
      agent: false,
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let firstChunkAt = -1;
      res.on('data', (chunk: Buffer) => {
        if (firstChunkAt < 0) firstChunkAt = Date.now() - started;
        chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          firstChunkAt,
        })
      );
    });
    req.on('error', reject);
    req.end(options.body ?? '{"model":"m","messages":[]}');
  });
}

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const keep = (message: string, fields?: Record<string, unknown>) =>
    lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
  return { lines, debug: keep, info: keep, warn: keep, error: keep };
}

const REAL_A = 'sk-ant-api03-REAL-KEY-OF-AGENT-A';
const REAL_B = 'sk-ant-oat01-REAL-TOKEN-OF-AGENT-B';

let upstream: Upstream;
let gateway: ProviderGateway;
let log: ReturnType<typeof recordingLog>;
/** The provider URLs the gateway chose; the stand-in answered them. */
let chosen: URL[];

/** A gateway whose calls reach the stand-in, recording the URL it chose. */
function makeGateway(deps: Partial<GatewayDeps> = {}): ProviderGateway {
  return new ProviderGateway({
    log,
    send: standInSend(
      () => upstream.url,
      (url) => chosen.push(url)
    ),
    ...deps,
  });
}

const ANTHROPIC = 'https://api.anthropic.com';
const OPENAI = 'https://api.openai.com';
const VERTEX_GLOBAL = 'https://aiplatform.googleapis.com';

function vertexRoute(): GatewayRoute {
  return {
    provider: 'vertex',
    upstream: VERTEX_GLOBAL,
    credential: async () => ({ header: 'authorization', value: 'Bearer ya29.SHORT-LIVED' }),
    vertex: { project: 'p1', region: 'global' },
  };
}

function openaiKey(value: string): GatewayRoute {
  return {
    provider: 'openai',
    upstream: OPENAI,
    credential: async () => ({ header: 'authorization', value: `Bearer ${value}` }),
  };
}

function anthropicKey(value: string): GatewayRoute {
  return {
    provider: 'anthropic',
    upstream: ANTHROPIC,
    credential: async () => ({ header: 'x-api-key', value }),
  };
}

function anthropicBearer(value: string): GatewayRoute {
  return {
    provider: 'anthropic',
    upstream: ANTHROPIC,
    credential: async () => ({ header: 'authorization', value: `Bearer ${value}` }),
  };
}

beforeEach(async () => {
  upstream = new Upstream();
  await upstream.start();
  log = recordingLog();
  chosen = [];
  gateway = makeGateway();
  await gateway.start();
  gateway.setReady();
});

afterEach(async () => {
  await gateway.close();
  await upstream.stop();
});

describe('who may call', () => {
  it('refuses a call with no token, or one it never issued', async () => {
    expect((await call(gateway.endpoint, '/v1/messages')).status).toBe(401);
    expect(
      (
        await call(gateway.endpoint, '/v1/messages', {
          headers: { 'x-api-key': `${GATEWAY_TOKEN_PREFIX}made-up` },
        })
      ).status
    ).toBe(401);
    expect(
      (await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': REAL_A } })).status
    ).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it('tells an unknown token to retry while the controller is still starting', async () => {
    const starting = makeGateway();
    await starting.start();
    try {
      const res = await call(starting.endpoint, '/v1/messages', {
        headers: { 'x-api-key': `${GATEWAY_TOKEN_PREFIX}not-yet` },
      });
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
    } finally {
      await starting.close();
    }
  });

  it('a token works only for its own agent’s login', async () => {
    const tokenA = gateway.mint('agent-a', anthropicKey(REAL_A));
    gateway.mint('agent-b', anthropicBearer(REAL_B));
    await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': tokenA } });
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.headers['x-api-key']).toBe(REAL_A);
    expect(upstream.seen[0]!.headers.authorization).toBeUndefined();
  });

  it('stops a withdrawn login at once, and keeps the token across a change', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    gateway.update('agent-a', anthropicKey('sk-ant-api03-ROTATED'));
    await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(upstream.seen[0]!.headers['x-api-key']).toBe('sk-ant-api03-ROTATED');
    gateway.forget('agent-a');
    const after = await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(after.status).toBe(401);
    expect(upstream.seen).toHaveLength(1);
  });
});

describe('what reaches the provider', () => {
  it('swaps an API key: the provider sees the real key, never the opaque token', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    const res = await call(gateway.endpoint, '/v1/messages', {
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', cookie: 'c=1' },
      body: '{"model":"m","messages":[{"role":"user","content":"hi"}]}',
    });
    expect(res.status).toBe(200);
    const seen = upstream.seen[0]!;
    expect(seen.method).toBe('POST');
    expect(seen.path).toBe('/v1/messages');
    expect(seen.headers['x-api-key']).toBe(REAL_A);
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.headers.cookie).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain(GATEWAY_TOKEN_PREFIX);
    expect(seen.body).toContain('"content":"hi"');
    // The provider's cookie doesn't come back to the agent.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('swaps a setup-token sent as a bearer', async () => {
    const token = gateway.mint('agent-b', anthropicBearer(REAL_B));
    await call(gateway.endpoint, '/v1/messages', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    const seen = upstream.seen[0]!;
    expect(seen.headers.authorization).toBe(`Bearer ${REAL_B}`);
    expect(seen.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('sends the call to the provider’s own host only', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(chosen.map((url) => url.href)).toEqual(['https://api.anthropic.com/v1/messages']);
  });

  it('keeps only the query parameters each provider needs, and drops the rest', async () => {
    const anthropic = gateway.mint('agent-a', anthropicKey(REAL_A));
    const openai = gateway.mint('agent-o', openaiKey('sk-proj-REAL'));
    const vertex = gateway.mint('agent-v', vertexRoute());
    const predict =
      '/v1/projects/p1/locations/global/publishers/anthropic/models/claude:streamRawPredict';
    await call(gateway.endpoint, '/v1/messages?beta=true&key=AIza-x&beta=false', {
      headers: { 'x-api-key': anthropic },
    });
    await call(gateway.endpoint, '/v1/responses?organization=org-other', {
      headers: { authorization: `Bearer ${openai}` },
    });
    await call(baseUrlWithToken(gateway.endpoint, vertex), `${predict}?alt=sse&key=AIza-x`);
    await call(baseUrlWithToken(gateway.endpoint, vertex), `${predict}?alt=media`);
    expect(upstream.seen.map((s) => s.path)).toEqual([
      '/v1/messages?beta=true',
      '/v1/responses',
      `${predict}?alt=sse`,
      predict,
    ]);
  });

  it('passes on only the headers each provider’s CLI needs: never one choosing another account or project', async () => {
    const steering = {
      'openai-organization': 'org-OTHER',
      'openai-project': 'proj_OTHER',
      'x-goog-user-project': 'other-billing-project',
      'x-forwarded-for': '10.0.0.1',
      'x-custom-anything': 'x',
      cookie: 'c=1',
    };
    const predict =
      '/v1/projects/p1/locations/global/publishers/anthropic/models/claude:streamRawPredict';
    const anthropic = gateway.mint('agent-a', anthropicKey(REAL_A));
    const openai = gateway.mint('agent-o', openaiKey('sk-proj-REAL'));
    const vertex = gateway.mint('agent-v', vertexRoute());
    await call(gateway.endpoint, '/v1/messages', {
      headers: {
        ...steering,
        'x-api-key': anthropic,
        'anthropic-version': '2023-06-01',
        'x-stainless-lang': 'js',
      },
    });
    await call(gateway.endpoint, '/v1/responses', {
      headers: {
        ...steering,
        authorization: `Bearer ${openai}`,
        'openai-beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      },
    });
    await call(baseUrlWithToken(gateway.endpoint, vertex), predict, {
      headers: { ...steering, 'anthropic-beta': 'b' },
    });
    expect(upstream.seen).toHaveLength(3);
    for (const seen of upstream.seen) {
      for (const name of Object.keys(steering)) expect(seen.headers[name]).toBeUndefined();
      expect(seen.headers['content-type']).toBe('application/json');
    }
    expect(upstream.seen[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream.seen[0]!.headers['x-stainless-lang']).toBe('js');
    expect(upstream.seen[1]!.headers['openai-beta']).toBe('responses=experimental');
    expect(upstream.seen[1]!.headers.originator).toBe('codex_cli_rs');
    expect(upstream.seen[1]!.headers.authorization).toBe('Bearer sk-proj-REAL');
    expect(upstream.seen[2]!.headers['anthropic-beta']).toBe('b');
    expect(upstream.seen[2]!.headers.authorization).toBe('Bearer ya29.SHORT-LIVED');
  });

  it('streams the answer as it comes, not once it ends', async () => {
    upstream.respond = async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      await delay(400);
      res.end('event: message_stop\ndata: {}\n\n');
    };
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    const res = await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(res.body).toBe('event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n');
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.firstChunkAt).toBeLessThan(300);
  });

  it('passes the provider’s own errors back unchanged', async () => {
    upstream.respond = (res) => {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"overloaded_error"}}');
    };
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    const res = await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(res.status).toBe(529);
    expect(res.body).toContain('overloaded_error');
  });
});

describe('a token in the base URL', () => {
  it('serves a CLI that sends no credential (Vertex with its own auth skipped), stripping the token', async () => {
    const token = gateway.mint('agent-v', vertexRoute());
    const base = baseUrlWithToken(gateway.endpoint, token);
    const path =
      '/v1/projects/p1/locations/global/publishers/anthropic/models/claude:streamRawPredict';
    const res = await call(base, path);
    expect(res.status).toBe(200);
    expect(upstream.seen[0]!.path).toBe(path);
    expect(upstream.seen[0]!.headers.authorization).toBe('Bearer ya29.SHORT-LIVED');
    expect(JSON.stringify(upstream.seen[0])).not.toContain(GATEWAY_TOKEN_PREFIX);
  });

  it('refuses a withdrawn or made-up token in the base URL', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    gateway.forget('agent-a');
    expect((await call(baseUrlWithToken(gateway.endpoint, token), '/v1/messages')).status).toBe(
      401
    );
    expect(
      (
        await call(
          baseUrlWithToken(gateway.endpoint, `${GATEWAY_TOKEN_PREFIX}${'x'.repeat(30)}`),
          '/v1/messages'
        )
      ).status
    ).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });
});

describe('what it refuses', () => {
  it('only forwards the routes the provider’s CLI needs', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    const headers = { 'x-api-key': token };
    expect((await call(gateway.endpoint, '/v1/files', { headers })).status).toBe(403);
    expect((await call(gateway.endpoint, '/v1/messages', { method: 'GET', headers })).status).toBe(
      403
    );
    expect((await call(gateway.endpoint, '/v1/messages%2f..%2fadmin', { headers })).status).toBe(
      403
    );
    expect((await call(gateway.endpoint, '/v1/messages/count_tokens', { headers })).status).toBe(
      200
    );
    expect(upstream.seen.map((s) => s.path)).toEqual(['/v1/messages/count_tokens']);
  });

  it('holds a Vertex login to its own project and region', async () => {
    const token = gateway.mint('agent-v', vertexRoute());
    const headers = { authorization: `Bearer ${token}` };
    const own =
      '/v1/projects/p1/locations/global/publishers/anthropic/models/claude:streamRawPredict';
    const other =
      '/v1/projects/p2/locations/global/publishers/anthropic/models/claude:streamRawPredict';
    expect((await call(gateway.endpoint, own, { headers })).status).toBe(200);
    expect((await call(gateway.endpoint, other, { headers })).status).toBe(403);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.headers.authorization).toBe('Bearer ya29.SHORT-LIVED');
  });

  it('refuses a body larger than the limit, without calling the provider', async () => {
    const small = makeGateway({ limits: { maxBodyBytes: 64 } });
    await small.start();
    small.setReady();
    try {
      const token = small.mint('agent-a', anthropicKey(REAL_A));
      const res = await call(small.endpoint, '/v1/messages', {
        headers: { 'x-api-key': token },
        body: JSON.stringify({ pad: 'x'.repeat(200) }),
      });
      expect(res.status).toBe(413);
      expect(upstream.seen).toHaveLength(0);
    } finally {
      await small.close();
    }
  });

  it('limits one agent’s calls in flight, and not another agent’s', async () => {
    const tight = makeGateway({ limits: { maxConcurrentPerAgent: 1 } });
    await tight.start();
    tight.setReady();
    const waiting: (() => void)[] = [];
    const releaseAll = () => {
      for (const go of waiting.splice(0)) go();
    };
    upstream.respond = async (res) => {
      await new Promise<void>((r) => waiting.push(r));
      res.writeHead(200);
      res.end('{}');
    };
    try {
      const tokenA = tight.mint('agent-a', anthropicKey(REAL_A));
      const tokenB = tight.mint('agent-b', anthropicKey(REAL_B));
      const first = call(tight.endpoint, '/v1/messages', { headers: { 'x-api-key': tokenA } });
      await delay(100);
      const second = await call(tight.endpoint, '/v1/messages', {
        headers: { 'x-api-key': tokenA },
      });
      expect(second.status).toBe(429);
      expect(second.headers['retry-after']).toBe('1');
      const other = call(tight.endpoint, '/v1/messages', { headers: { 'x-api-key': tokenB } });
      await delay(100);
      // agent-b got through while agent-a was at its limit.
      expect(waiting).toHaveLength(2);
      releaseAll();
      expect((await first).status).toBe(200);
      expect((await other).status).toBe(200);
    } finally {
      await tight.close();
    }
  });

  it('limits one agent’s calls per minute', async () => {
    let clock = 1_000_000;
    const counted = makeGateway({ limits: { maxPerMinutePerAgent: 2 }, now: () => clock });
    await counted.start();
    counted.setReady();
    try {
      const token = counted.mint('agent-a', anthropicKey(REAL_A));
      const headers = { 'x-api-key': token };
      expect((await call(counted.endpoint, '/v1/messages', { headers })).status).toBe(200);
      expect((await call(counted.endpoint, '/v1/messages', { headers })).status).toBe(200);
      expect((await call(counted.endpoint, '/v1/messages', { headers })).status).toBe(429);
      clock += 61_000;
      expect((await call(counted.endpoint, '/v1/messages', { headers })).status).toBe(200);
    } finally {
      await counted.close();
    }
  });

  it('says the provider is unreachable rather than hanging', async () => {
    const nowhere = makeGateway({ send: standInSend(() => 'http://127.0.0.1:1') });
    await nowhere.start();
    nowhere.setReady();
    try {
      const token = nowhere.mint('agent-a', anthropicKey(REAL_A));
      const res = await call(nowhere.endpoint, '/v1/messages', {
        headers: { 'x-api-key': token },
      });
      expect(res.status).toBe(502);
      expect(res.body).toContain('could not reach the provider');
    } finally {
      await nowhere.close();
    }
  });

  it('fronts a route only to its provider’s own https host', () => {
    const anthropicTo = (upstream: string): GatewayRoute => ({ ...anthropicKey(REAL_A), upstream });
    for (const upstream of [
      'http://api.anthropic.com',
      'https://api.anthropic.com/',
      'https://api.anthropic.com:8443',
      'https://user@api.anthropic.com',
      'https://api.anthropic.com.attacker.example',
      'https://api.anthropic.com/v1',
      OPENAI,
    ])
      expect(() => gateway.mint('agent-a', anthropicTo(upstream)), upstream).toThrow(
        'only to its own API host'
      );
    expect(() => gateway.mint('agent-o', { ...openaiKey('k'), upstream: ANTHROPIC })).toThrow();
    // Vertex: the host of the login's own region, and the global host for global.
    const regional = { project: 'p1', region: 'us-east5' };
    expect(() =>
      gateway.mint('agent-v', { ...vertexRoute(), vertex: regional, upstream: VERTEX_GLOBAL })
    ).toThrow();
    expect(() =>
      gateway.mint('agent-v', {
        ...vertexRoute(),
        vertex: regional,
        upstream: 'https://europe-west1-aiplatform.googleapis.com',
      })
    ).toThrow();
    expect(() =>
      gateway.mint('agent-v', {
        ...vertexRoute(),
        vertex: { project: 'p1', region: 'evil' },
        upstream: 'https://evil-aiplatform.googleapis.com',
      })
    ).toThrow();
    expect(() => gateway.mint('agent-v', { ...vertexRoute(), vertex: undefined })).toThrow();
    expect(
      gateway
        .mint('agent-v', {
          ...vertexRoute(),
          vertex: regional,
          upstream: 'https://us-east5-aiplatform.googleapis.com',
        })
        .startsWith(GATEWAY_TOKEN_PREFIX)
    ).toBe(true);
    expect(gateway.has('agent-a')).toBe(false);
  });

  it('refuses a bad upstream in update and register too, keeping what the agent had', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    const bad = { ...anthropicKey('sk-ant-api03-OTHER'), upstream: 'https://attacker.example' };
    expect(() => gateway.update('agent-a', bad)).toThrow();
    expect(() =>
      gateway.register('agent-b', `${GATEWAY_TOKEN_PREFIX}${'b'.repeat(43)}`, bad)
    ).toThrow();
    expect(gateway.has('agent-b')).toBe(false);
    await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(upstream.seen[0]!.headers['x-api-key']).toBe(REAL_A);
    expect(chosen[0]!.origin).toBe(ANTHROPIC);
  });

  it('says so when the credential can’t be had, and logs a fixed reason, never the error', async () => {
    const token = gateway.mint('agent-a', {
      provider: 'anthropic',
      upstream: ANTHROPIC,
      credential: async () => {
        throw new Error('token exchange failed for ya29.LEAKED-IN-AN-ERROR');
      },
    });
    const res = await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(res.status).toBe(502);
    expect(upstream.seen).toHaveLength(0);
    const all = log.lines.join('\n');
    expect(all).toContain('"reason":"credential_unavailable"');
    expect(all).not.toContain('LEAKED');
    expect(all).not.toContain('token exchange failed');
  });
});

describe('its counts', () => {
  it('counts the agents it fronts and the calls it refused', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    gateway.mint('agent-b', anthropicBearer(REAL_B));
    expect(gateway.counts()).toEqual({ agents: 2, refused: 0 });
    await call(gateway.endpoint, '/v1/files', { headers: { 'x-api-key': token } });
    await call(gateway.endpoint, '/v1/messages');
    gateway.forget('agent-b');
    expect(gateway.counts()).toEqual({ agents: 1, refused: 2 });
  });
});

describe('what it logs', () => {
  it('never logs a credential, an opaque token or a body', async () => {
    const token = gateway.mint('agent-a', anthropicKey(REAL_A));
    await call(gateway.endpoint, '/v1/messages', {
      headers: { 'x-api-key': token },
      body: '{"messages":[{"content":"SECRET-PROMPT-TEXT"}]}',
    });
    await call(gateway.endpoint, '/v1/files', { headers: { 'x-api-key': token } });
    await call(gateway.endpoint, '/v1/messages', {
      headers: { 'x-api-key': `${GATEWAY_TOKEN_PREFIX}wrong` },
    });
    const all = log.lines.join('\n');
    expect(all).not.toContain(REAL_A);
    expect(all).not.toContain(token);
    expect(all).not.toContain(GATEWAY_TOKEN_PREFIX);
    expect(all).not.toContain('SECRET-PROMPT-TEXT');
    expect(all).toContain('"reason":"route"');
  });

  it('never logs a path carrying a token, whether the call is served or refused', async () => {
    const token = gateway.mint('agent-v', vertexRoute());
    const base = baseUrlWithToken(gateway.endpoint, token);
    const own =
      '/v1/projects/p1/locations/global/publishers/anthropic/models/claude:streamRawPredict';
    const other =
      '/v1/projects/p2/locations/global/publishers/anthropic/models/claude:streamRawPredict';
    expect((await call(base, own)).status).toBe(200);
    expect((await call(base, other)).status).toBe(403);
    expect((await call(base, '/v1/files')).status).toBe(403);
    const made = `${GATEWAY_TOKEN_PREFIX}${'z'.repeat(40)}`;
    expect((await call(baseUrlWithToken(gateway.endpoint, made), own)).status).toBe(401);
    upstream.respond = (res) => {
      res.destroy();
    };
    expect((await call(base, own)).status).toBe(502);
    expect(log.lines.length).toBeGreaterThan(3);
    const all = log.lines.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(made);
    expect(all).not.toContain(GATEWAY_TOKEN_PREFIX);
    expect(all).not.toContain('/t/');
    expect(all).not.toContain('/v1/projects');
  });

  it('says a repeated refusal once a minute, with a count', async () => {
    let clock = 5_000_000;
    const quiet = makeGateway({ now: () => clock });
    await quiet.start();
    quiet.setReady();
    try {
      const token = quiet.mint('agent-a', anthropicKey(REAL_A));
      for (let i = 0; i < 3; i++)
        await call(quiet.endpoint, '/v1/files', { headers: { 'x-api-key': token } });
      clock += 61_000;
      await call(quiet.endpoint, '/v1/files', { headers: { 'x-api-key': token } });
      const refusals = log.lines.filter((l) => l.startsWith('The provider gateway refused a call'));
      expect(refusals).toHaveLength(2);
      expect(refusals[1]).toContain('"sinceLastSaid":2');
    } finally {
      await quiet.close();
    }
  });
});

describe('a probe token', () => {
  it('works for a few calls, then is used up', async () => {
    const token = gateway.mintProbe('p1', anthropicKey(REAL_A));
    const headers = { 'x-api-key': token };
    for (let i = 0; i < PROBE_MAX_CALLS; i++)
      expect((await call(gateway.endpoint, '/v1/messages', { headers })).status).toBe(200);
    const after = await call(gateway.endpoint, '/v1/messages', { headers });
    expect(after.status).toBe(401);
    expect(after.body).toContain('expired or been used up');
    expect(upstream.seen).toHaveLength(PROBE_MAX_CALLS);
    expect(upstream.seen[0]!.headers['x-api-key']).toBe(REAL_A);
  });

  it('a refused route doesn’t spend a call, and other providers’ routes stay shut', async () => {
    const token = gateway.mintProbe('p1', anthropicKey(REAL_A));
    const headers = { 'x-api-key': token };
    expect((await call(gateway.endpoint, '/v1/files', { headers })).status).toBe(403);
    expect((await call(gateway.endpoint, '/v1/responses', { headers })).status).toBe(403);
    for (let i = 0; i < PROBE_MAX_CALLS; i++)
      expect((await call(gateway.endpoint, '/v1/messages', { headers })).status).toBe(200);
  });

  it('stops after two minutes, whether or not it was used', async () => {
    let clock = 9_000_000;
    const timed = makeGateway({ now: () => clock });
    await timed.start();
    timed.setReady();
    try {
      const used = timed.mintProbe('p1', anthropicKey(REAL_A));
      timed.mintProbe('p2', anthropicKey(REAL_A));
      const headers = { 'x-api-key': used };
      expect((await call(timed.endpoint, '/v1/messages', { headers })).status).toBe(200);
      clock += PROBE_LIFETIME_MS - 1;
      expect((await call(timed.endpoint, '/v1/messages', { headers })).status).toBe(200);
      expect(timed.probes()).toBe(2);
      clock += 1;
      expect((await call(timed.endpoint, '/v1/messages', { headers })).status).toBe(401);
      // The unused one went too, without a call or a forget.
      expect(timed.probes()).toBe(0);
      expect(log.lines.join('\n')).toContain('"reason":"probe_expired"');
    } finally {
      await timed.close();
    }
  });

  it('stops at once when the probe ends', async () => {
    const token = gateway.mintProbe('p1', anthropicKey(REAL_A));
    gateway.forgetProbe('p1');
    expect(
      (await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } })).status
    ).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it('is never renewed, registered again or counted as an agent', async () => {
    const token = gateway.mintProbe('p1', anthropicKey(REAL_A));
    expect(gateway.update('probe:p1', anthropicKey(REAL_B))).toBe(false);
    expect(() => gateway.register('probe:p1', token, anthropicKey(REAL_A))).toThrow();
    expect(() => gateway.mint('probe:p1', anthropicKey(REAL_A))).toThrow();
    expect(() => gateway.mintProbe('p1', anthropicKey(REAL_A))).toThrow();
    expect(() => gateway.mintProbe('bad id/..', anthropicKey(REAL_A))).toThrow();
    expect(() =>
      gateway.mintProbe('p2', { ...anthropicKey(REAL_A), upstream: 'https://attacker.example' })
    ).toThrow();
    gateway.mint('agent-a', anthropicKey(REAL_A));
    expect(gateway.counts().agents).toBe(1);
    expect(gateway.probes()).toBe(1);
    await call(gateway.endpoint, '/v1/messages', { headers: { 'x-api-key': token } });
    expect(upstream.seen[0]!.headers['x-api-key']).toBe(REAL_A);
    expect(log.lines.join('\n')).not.toContain(token);
  });
});

describe('the box’s daily call cap', () => {
  it('refuses calls past the cap with a plain 429 until 00:00 UTC, and refused calls don’t count', async () => {
    const noon = Date.UTC(2026, 9, 28, 12, 0, 0);
    let text: string | null = null;
    const cap = new DailyCallCap({
      cap: 3,
      file: { read: () => text, write: (t) => void (text = t) },
      log,
      now: () => noon,
    });
    const capped = makeGateway({ cap, now: () => noon });
    await capped.start();
    capped.setReady();
    try {
      const agent = capped.mint('agent-a', anthropicKey(REAL_A));
      const probe = capped.mintProbe('p1', anthropicKey(REAL_A));
      // Refused for other reasons: not counted.
      await call(capped.endpoint, '/v1/files', { headers: { 'x-api-key': agent } });
      await call(capped.endpoint, '/v1/messages', { headers: { 'x-api-key': 'swpg_wrong' } });
      expect(cap.counts().callsToday).toBe(0);
      // An agent's calls and a probe's both count.
      for (const token of [agent, probe, agent])
        expect(
          (await call(capped.endpoint, '/v1/messages', { headers: { 'x-api-key': token } })).status
        ).toBe(200);
      const over = await call(capped.endpoint, '/v1/messages', { headers: { 'x-api-key': probe } });
      expect(over.status).toBe(429);
      expect(over.headers['retry-after']).toBe(String(12 * 3600));
      expect(over.body).toContain('daily AI limit');
      expect(upstream.seen).toHaveLength(3);
      expect(cap.counts()).toEqual({ callsToday: 3, capped: true });
      expect(log.lines.join('\n')).toContain('"reason":"daily_cap"');
      // The refused probe call didn't use up one of its own calls either.
      expect(log.lines.join('\n')).not.toContain(probe);
    } finally {
      await capped.close();
    }
  });
});
