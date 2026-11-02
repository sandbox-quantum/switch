import { describe, expect, it } from 'vitest';
import { gatewayPlanFor, VertexTokenCache, vertexUpstream } from './gateway-logins';
import type { GivenLogin } from './sealed-logins';
import { VertexTokens } from './vertex-tokens';

const ENDPOINT = 'http://127.0.0.1:41000';
const TOKEN = `swpg_${'a'.repeat(43)}`;

function login(fields: Partial<GivenLogin> & Pick<GivenLogin, 'kind' | 'credential'>): GivenLogin {
  return { status: 'connected', revision: '1', provider: 'claude', ...fields } as GivenLogin;
}

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

/** A cache whose tokens never call Google. */
function quietCache(): VertexTokenCache {
  return new VertexTokenCache(
    () =>
      new VertexTokens(
        {
          type: 'authorized_user',
          client_id: 'c',
          client_secret: 's',
          refresh_token: 'r',
        } as never,
        { post: async () => ({ status: 200, body: { access_token: 'ya29.T', expires_in: 3600 } }) }
      )
  );
}

describe('the CLI never gets the login', () => {
  for (const [name, given] of [
    ['a Claude API key', login({ kind: 'api-key', credential: 'sk-ant-api03-REAL' })],
    ['a Claude setup-token', login({ kind: 'setup-token', credential: 'sk-ant-oat01-REAL' })],
    ['a Claude Vertex login', login({ kind: 'vertex', credential: VERTEX })],
    ['a Codex API key', login({ provider: 'codex', kind: 'api-key', credential: 'sk-proj-REAL' })],
  ] as const) {
    it(`${name}: the environment holds the gateway and its token only`, () => {
      const plan = gatewayPlanFor(given, quietCache())!;
      expect(plan).not.toBeNull();
      const env = JSON.stringify(plan.env(ENDPOINT, TOKEN));
      expect(env).not.toContain('REAL');
      expect(env).not.toContain('refresh_token');
      expect(env).toContain(TOKEN);
      expect(env).toContain(ENDPOINT);
    });
  }
});

describe('each login', () => {
  it('a Claude API key: the gateway adds x-api-key, the CLI uses ANTHROPIC_API_KEY', async () => {
    const plan = gatewayPlanFor(
      login({ kind: 'api-key', credential: 'sk-ant-api03-REAL' }),
      quietCache()
    )!;
    expect(plan.route.provider).toBe('anthropic');
    expect(await plan.route.credential()).toEqual({
      header: 'x-api-key',
      value: 'sk-ant-api03-REAL',
    });
    expect(plan.env(ENDPOINT, TOKEN)).toMatchObject({
      ANTHROPIC_BASE_URL: ENDPOINT,
      ANTHROPIC_API_KEY: TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_USE_VERTEX: '',
    });
  });

  it('a Claude setup-token: the gateway adds a bearer, the CLI uses ANTHROPIC_AUTH_TOKEN', async () => {
    const plan = gatewayPlanFor(
      login({ kind: 'setup-token', credential: 'sk-ant-oat01-REAL' }),
      quietCache()
    )!;
    expect(await plan.route.credential()).toEqual({
      header: 'authorization',
      value: 'Bearer sk-ant-oat01-REAL',
    });
    expect(plan.env(ENDPOINT, TOKEN)).toMatchObject({
      ANTHROPIC_BASE_URL: ENDPOINT,
      ANTHROPIC_AUTH_TOKEN: TOKEN,
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
  });

  it('a Claude Vertex login: Google tokens from the gateway, the token in the base URL, no key file', async () => {
    const plan = gatewayPlanFor(login({ kind: 'vertex', credential: VERTEX }), quietCache())!;
    expect(plan.route).toMatchObject({
      provider: 'vertex',
      upstream: 'https://aiplatform.googleapis.com',
      vertex: { project: 'example-project', region: 'global' },
    });
    expect(await plan.route.credential()).toEqual({
      header: 'authorization',
      value: 'Bearer ya29.T',
    });
    expect(plan.env(ENDPOINT, TOKEN)).toEqual({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'example-project',
      CLOUD_ML_REGION: 'global',
      ANTHROPIC_VERTEX_BASE_URL: `${ENDPOINT}/t/${TOKEN}/v1`,
    });
  });

  it('a Codex API key: OPENAI_BASE_URL on the gateway', async () => {
    const plan = gatewayPlanFor(
      login({ provider: 'codex', kind: 'api-key', credential: 'sk-proj-REAL' }),
      quietCache()
    )!;
    expect(plan.route.provider).toBe('openai');
    expect(plan.env(ENDPOINT, TOKEN)).toEqual({
      OPENAI_BASE_URL: `${ENDPOINT}/v1`,
      OPENAI_API_KEY: TOKEN,
    });
  });

  it('a login the gateway can’t front is not gateway-backed', () => {
    expect(
      gatewayPlanFor(login({ provider: 'cursor', kind: 'api-key', credential: 'k' }), quietCache())
    ).toBeNull();
    expect(
      gatewayPlanFor(
        login({ provider: 'codex', kind: 'auth-json', credential: '{}' }),
        quietCache()
      )
    ).toBeNull();
    expect(
      gatewayPlanFor(
        login({ provider: 'antigravity', kind: 'auth-json', credential: '{}' }),
        quietCache()
      )
    ).toBeNull();
  });
});

describe('Vertex token cache', () => {
  it('shares one minter per login revision, and drops older revisions', () => {
    let made = 0;
    const cache = new VertexTokenCache(() => {
      made += 1;
      return new VertexTokens({
        type: 'authorized_user',
        client_id: 'c',
        client_secret: 's',
        refresh_token: 'r',
      } as never);
    });
    const one = login({ kind: 'vertex', credential: VERTEX, revision: '1' });
    expect(cache.for(one)).toBe(cache.for(one));
    expect(made).toBe(1);
    const two = login({ kind: 'vertex', credential: VERTEX, revision: '2' });
    const second = cache.for(two);
    expect(made).toBe(2);
    expect(cache.for(two)).toBe(second);
    cache.forget('claude');
    cache.for(two);
    expect(made).toBe(3);
  });

  it('uses the regional Vertex host outside global', () => {
    expect(vertexUpstream('example-project', 'us-east5')).toBe(
      'https://us-east5-aiplatform.googleapis.com'
    );
    expect(vertexUpstream('example-project', 'global')).toBe('https://aiplatform.googleapis.com');
  });

  it('a region with no Vertex host of its own is not fronted', () => {
    expect(vertexUpstream('example-project', 'attacker.example#')).toBeNull();
    expect(vertexUpstream('example-project', 'evil')).toBeNull();
    const odd = JSON.parse(VERTEX) as Record<string, unknown>;
    odd.region = 'evil';
    expect(
      gatewayPlanFor(login({ kind: 'vertex', credential: JSON.stringify(odd) }), quietCache())
    ).toBeNull();
  });
});
