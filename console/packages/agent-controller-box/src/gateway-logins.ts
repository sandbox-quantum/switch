import { parseVertexLogin } from '@switch-console/agent-providers-box';
import { baseUrlWithToken, type GatewayRoute, upstreamFor } from './provider-gateway';
import type { GivenLogin } from './sealed-logins';
import { VertexTokens } from './vertex-tokens';

/**
 * Which given logins the provider gateway fronts, and how: the route the
 * gateway calls with the real credential, and the environment the agent's CLI
 * gets instead (a base URL on the gateway and its opaque token, never the
 * login). A login this returns null for is not gateway-backed, and hosted
 * boxes don't offer it.
 */
export type GatewayPlan = {
  route: GatewayRoute;
  /** The CLI's environment for this login, given the gateway's endpoint and the agent's token. */
  env: (endpoint: string, token: string) => Record<string, string>;
};

/** One `VertexTokens` per login revision, shared by every agent using it. */
export class VertexTokenCache {
  private readonly byKey = new Map<string, VertexTokens>();

  constructor(private readonly make: (login: GivenLogin) => VertexTokens = defaultTokens) {}

  for(login: GivenLogin): VertexTokens {
    const key = `${login.provider}:${login.revision}`;
    let tokens = this.byKey.get(key);
    if (!tokens) {
      tokens = this.make(login);
      // An older revision's tokens are never used again.
      for (const old of this.byKey.keys())
        if (old.startsWith(`${login.provider}:`)) this.byKey.delete(old);
      this.byKey.set(key, tokens);
    }
    return tokens;
  }

  /** The login was withdrawn: its cached access tokens go. */
  forget(provider: string): void {
    for (const key of [...this.byKey.keys()])
      if (key.startsWith(`${provider}:`)) {
        this.byKey.get(key)?.clear();
        this.byKey.delete(key);
      }
  }
}

function defaultTokens(login: GivenLogin): VertexTokens {
  return new VertexTokens(parseVertexLogin(login.credential).credentials);
}

/** The variables a CLI could sign in with, cleared so only the gateway's apply. */
const CLAUDE_CLEARED = {
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_VERTEX: '',
  GOOGLE_APPLICATION_CREDENTIALS: '',
};

/** Vertex's API host for a region, or null for a region with no host of its own. */
export function vertexUpstream(project: string, region: string): string | null {
  try {
    return upstreamFor('vertex', { project, region });
  } catch {
    return null;
  }
}

export function gatewayPlanFor(login: GivenLogin, vertex: VertexTokenCache): GatewayPlan | null {
  if (login.provider === 'claude' && login.kind === 'api-key')
    return {
      route: {
        provider: 'anthropic',
        upstream: upstreamFor('anthropic'),
        credential: async () => ({ header: 'x-api-key', value: login.credential }),
      },
      env: (endpoint, token) => ({
        ...CLAUDE_CLEARED,
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_API_KEY: token,
      }),
    };
  if (login.provider === 'claude' && login.kind === 'setup-token')
    return {
      route: {
        provider: 'anthropic',
        upstream: upstreamFor('anthropic'),
        credential: async () => ({ header: 'authorization', value: `Bearer ${login.credential}` }),
      },
      env: (endpoint, token) => ({
        ...CLAUDE_CLEARED,
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: token,
      }),
    };
  if (login.provider === 'claude' && login.kind === 'vertex') {
    const parsed = parseVertexLogin(login.credential);
    // A region with no Vertex host of its own isn't fronted, so isn't offered.
    const upstream = vertexUpstream(parsed.project, parsed.region);
    if (!upstream) return null;
    const tokens = vertex.for(login);
    return {
      route: {
        provider: 'vertex',
        upstream,
        credential: () => tokens.credential(),
        vertex: { project: parsed.project, region: parsed.region },
      },
      // Claude Code sends no Google credential of its own here, so its
      // token travels in the base URL.
      env: (endpoint, token) => ({
        ...CLAUDE_CLEARED,
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: parsed.project,
        CLOUD_ML_REGION: parsed.region,
        ANTHROPIC_VERTEX_BASE_URL: `${baseUrlWithToken(endpoint, token)}/v1`,
      }),
    };
  }
  if (login.provider === 'codex' && login.kind === 'api-key')
    return {
      route: {
        provider: 'openai',
        upstream: upstreamFor('openai'),
        credential: async () => ({ header: 'authorization', value: `Bearer ${login.credential}` }),
      },
      env: (endpoint, token) => ({
        OPENAI_BASE_URL: `${endpoint}/v1`,
        OPENAI_API_KEY: token,
      }),
    };
  return null;
}
