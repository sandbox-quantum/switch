import { createSign } from 'node:crypto';
import type { GoogleCredentials } from '@switch-console/agent-providers-box';
import { proxiedTokenPost } from './proxy-transport';

/**
 * Short-lived Google access tokens for a Vertex login, for the provider
 * gateway (`provider-gateway.ts`). The Google credential (a service account
 * key, or a user's application-default sign-in) stays in the controller's
 * memory; only the access token it buys is added to a call, upstream of the
 * agent. Claude Code is run with `CLAUDE_CODE_SKIP_VERTEX_AUTH=1`, so it never
 * holds either.
 *
 * A token is kept until shortly before it expires, and one exchange serves
 * every call that arrives while it runs.
 */

/** The scope Vertex calls need. */
export const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Google's token endpoint: the only one a login's credential is ever sent to. */
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** The longest a bought token is kept, whatever Google's answer says. */
export const MAX_TOKEN_LIFETIME_S = 3600;
/** A token is renewed this long before it expires. */
export const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** Google service-account assertions may last at most an hour. */
const ASSERTION_LIFETIME_S = 3600;

/** Posts a form to the token endpoint; replaced in tests. */
export type TokenPost = (
  url: string,
  form: Record<string, string>
) => Promise<{ status: number; body: unknown }>;

/** Google answered the token exchange with a refusal (`status` is its HTTP status). */
export class TokenRefused extends Error {
  constructor(readonly status: number) {
    // Never the body: an error answer can echo what was sent.
    super(`Google refused the Vertex token exchange (HTTP ${status}).`);
    this.name = 'TokenRefused';
  }
}

/** The token exchange never got an answer from Google (the network or the proxy). */
export class TokenUnreachable extends Error {
  constructor() {
    super('Could not reach Google for a Vertex access token.');
    this.name = 'TokenUnreachable';
  }
}

export type VertexTokensDeps = {
  /** Posts the form to Google; through the box's proxy by default, replaced in tests. */
  post?: TokenPost;
  now?: () => number;
};

export class VertexTokens {
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  /** Bumped by `clear()`: an exchange started before it is never kept. */
  private generation = 0;
  private readonly post: TokenPost;
  private readonly now: () => number;

  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly deps: VertexTokensDeps = {}
  ) {
    this.post = deps.post ?? proxiedTokenPost();
    this.now = deps.now ?? Date.now;
  }

  /** The header the gateway adds upstream. */
  async credential(): Promise<{ header: string; value: string }> {
    return { header: 'authorization', value: `Bearer ${await this.token()}` };
  }

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - RENEW_BEFORE_MS)
      return this.cached.token;
    if (!this.pending) {
      const run: Promise<string> = this.exchange().finally(() => {
        // Only its own: `clear()` may have started another since.
        if (this.pending === run) this.pending = null;
      });
      this.pending = run;
    }
    return this.pending;
  }

  /**
   * Drops the cached token: the login changed or was withdrawn. An exchange
   * already running is not kept either, and the next call starts its own.
   */
  clear(): void {
    this.cached = null;
    this.pending = null;
    this.generation += 1;
  }

  private async exchange(): Promise<string> {
    const creds = this.credentials;
    // The credential goes to Google only, whatever the file names.
    if (creds.type === 'service_account' && creds.token_uri && creds.token_uri !== GOOGLE_TOKEN_URI)
      throw new Error('This Vertex login names a token endpoint other than Google’s.');
    const uri = GOOGLE_TOKEN_URI;
    const generation = this.generation;
    const form: Record<string, string> =
      creds.type === 'service_account'
        ? {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: this.assertion(uri),
          }
        : {
            grant_type: 'refresh_token',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            refresh_token: creds.refresh_token,
          };
    const started = this.now();
    let answer: Awaited<ReturnType<TokenPost>>;
    try {
      answer = await this.post(uri, form);
    } catch {
      // Not the error itself: it says nothing about the login, and is kept out of logs.
      throw new TokenUnreachable();
    }
    const body = (answer.body ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (answer.status !== 200 || typeof body.access_token !== 'string' || !body.access_token)
      throw new TokenRefused(answer.status);
    const lifetimeS =
      typeof body.expires_in === 'number' && body.expires_in > 0
        ? Math.min(body.expires_in, MAX_TOKEN_LIFETIME_S)
        : MAX_TOKEN_LIFETIME_S;
    if (generation === this.generation)
      this.cached = { token: body.access_token, expiresAt: started + lifetimeS * 1000 };
    return body.access_token;
  }

  /** A signed JWT asking for a token as the service account (RS256). */
  private assertion(audience: string): string {
    const creds = this.credentials;
    if (creds.type !== 'service_account') throw new Error('Not a service account.');
    const issued = Math.floor(this.now() / 1000);
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      ...(creds.private_key_id ? { kid: creds.private_key_id } : {}),
    };
    const claims = {
      iss: creds.client_email,
      scope: VERTEX_SCOPE,
      aud: audience,
      iat: issued,
      exp: issued + ASSERTION_LIFETIME_S,
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(creds.private_key);
    return `${unsigned}.${signature.toString('base64url')}`;
  }
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url');
}
