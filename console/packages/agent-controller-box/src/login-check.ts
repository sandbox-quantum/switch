import { type GoogleCredentials, parseVertexLogin } from '@switch-console/agent-providers-box';
import type { GivenLogin } from './sealed-logins';
import { TokenRefused, TokenUnreachable, VertexTokens } from './vertex-tokens';

/**
 * Whether a login given to the machine works with its provider, beyond the
 * CLI's own sign-in check.
 *
 * Only a Vertex AI login needs it. Claude Code runs with
 * `CLAUDE_CODE_SKIP_VERTEX_AUTH=1` here, because the box buys Google's access
 * tokens itself (`vertex-tokens.ts`), so Claude's check passes without ever
 * asking Google, and a made-up key file would read "ok" until the first real
 * message. So the box asks Google for one access token, as an agent's first
 * call would, before it says the login is ok.
 *
 * - `ok`: Google gave a token, or the login isn't a Vertex one.
 * - `rejected`: Google refused the key, or it can't be used to ask at all.
 * - `unreachable`: no answer from Google (or a passing error on its side), so
 *   nothing is known about the key: never reported as ok.
 *
 * Only the verdict comes back: nothing Google said, and nothing of the key.
 */
export type LoginVerdict = 'ok' | 'rejected' | 'unreachable';

export type LoginCheck = (login: GivenLogin) => Promise<LoginVerdict>;

/** Google's answers that say nothing about the key: try again later. */
function passing(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function verdictFor(error: unknown): LoginVerdict {
  if (error instanceof TokenUnreachable) return 'unreachable';
  if (error instanceof TokenRefused) return passing(error.status) ? 'unreachable' : 'rejected';
  // Anything else happened before Google was asked (the key couldn't sign the
  // request, or names another token endpoint): the key is no good.
  return 'rejected';
}

/**
 * The check for given logins. `tokens` makes a fresh `VertexTokens` for each
 * check, so a token cached for running agents never stands in for asking
 * Google again; replaced in tests.
 */
export function givenLoginCheck(
  tokens: (credentials: GoogleCredentials) => Pick<VertexTokens, 'token'> = (credentials) =>
    new VertexTokens(credentials)
): LoginCheck {
  return async (login) => {
    if (login.provider !== 'claude' || login.kind !== 'vertex') return 'ok';
    let source: Pick<VertexTokens, 'token'>;
    try {
      source = tokens(parseVertexLogin(login.credential).credentials);
    } catch {
      return 'rejected';
    }
    try {
      await source.token();
      return 'ok';
    } catch (error) {
      return verdictFor(error);
    }
  };
}
