import { parseVertexLogin } from '@switch-console/agent-providers';
import type { GivenLogin } from '../sealed-logins';
import { type ChatgptTokenCache, parseChatgptSignIn } from './chatgpt-tokens';
import { baseUrlWithToken, type GatewayRoute, upstreamFor } from './provider-gateway';
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
  /**
   * Codex only: the configuration its sessions run with (TOML), which points
   * it at the gateway. Codex takes its base URL from configuration alone; it
   * reads neither `OPENAI_BASE_URL` nor, for a session, `OPENAI_API_KEY`.
   */
  codexConfig?: (endpoint: string) => string;
};

/** The token caches the plans share, one per kind of login that renews. */
export type LoginCaches = { vertex: VertexTokenCache; chatgpt: ChatgptTokenCache };

/**
 * The providers a box signs in through a browser: those whose sign-in ends in
 * a login `gatewayPlanFor` fronts. Claude Code's ends in a setup token and
 * Codex's in a ChatGPT sign-in, which the gateway renews itself. OpenCode's
 * ChatGPT sign-in is in OpenCode's own file, which the gateway doesn't front,
 * and Cursor and Antigravity keep theirs inside the CLI, so the agents would
 * hold the login.
 */
export const BOX_BROWSER_SIGN_IN: readonly string[] = ['claude', 'codex'];

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

/** The custom provider a box's Codex sessions use, named so it can't be taken for OpenAI's own. */
const CODEX_GATEWAY_PROVIDER = 'switch_gateway';

/**
 * Codex's configuration for a gateway-backed login: a Responses provider at
 * `baseUrl` whose key is the agent's opaque token in `OPENAI_API_KEY`. Put
 * before any table of the session's own configuration, so its keys stay at
 * the top level.
 */
export function codexGatewayConfig(baseUrl: string): string {
  return (
    `model_provider = ${JSON.stringify(CODEX_GATEWAY_PROVIDER)}\n` +
    `model_providers.${CODEX_GATEWAY_PROVIDER} = { name = "Switch provider gateway", ` +
    `base_url = ${JSON.stringify(baseUrl)}, env_key = "OPENAI_API_KEY", wire_api = "responses" }\n`
  );
}

/** What a Codex session signs in with: only the gateway's token. */
function codexEnv(token: string): Record<string, string> {
  return { OPENAI_API_KEY: token, CODEX_API_KEY: '' };
}

/** Vertex's API host for a region, or null for a region with no host of its own. */
export function vertexUpstream(project: string, region: string): string | null {
  try {
    return upstreamFor('vertex', { project, region });
  } catch {
    return null;
  }
}

export function gatewayPlanFor(login: GivenLogin, caches: LoginCaches): GatewayPlan | null {
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
    const tokens = caches.vertex.for(login);
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
      env: (_endpoint, token) => codexEnv(token),
      codexConfig: (endpoint) => codexGatewayConfig(`${endpoint}/v1`),
    };
  // A ChatGPT sign-in: the gateway renews it and calls Codex's ChatGPT backend.
  // A sign-in file holding anything else (an API key) isn't fronted.
  if (
    login.provider === 'codex' &&
    login.kind === 'auth-json' &&
    parseChatgptSignIn(login.credential)
  ) {
    const tokens = caches.chatgpt.for(login);
    return {
      route: {
        provider: 'chatgpt',
        upstream: upstreamFor('chatgpt'),
        credential: () => tokens.credential(),
        rejected: (value) => tokens.rejected(value),
      },
      env: (_endpoint, token) => codexEnv(token),
      codexConfig: (endpoint) => codexGatewayConfig(`${endpoint}/backend-api/codex`),
    };
  }
  return null;
}
