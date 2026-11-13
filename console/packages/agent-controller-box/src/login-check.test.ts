import { generateKeyPairSync } from 'node:crypto';
import { vertexCredentialFixture } from '@switch-console/agent-providers-box/testing';
import { describe, expect, it } from 'vitest';
import { givenLoginCheck, verdictFor } from './login-check';
import type { GivenLogin } from './sealed-logins';
import { type TokenPost, TokenRefused, TokenUnreachable, VertexTokens } from './vertex-tokens';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** A key that can sign, so the exchange reaches the (fake) Google. */
const SIGNING_KEY = {
  type: 'service_account',
  private_key_id: 'key-1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: 'claude-vertex@acme-ai.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const MARKER = 'KEYMARKER-not-a-real-secret';

function vertex(credentials: object = SIGNING_KEY): GivenLogin {
  return {
    status: 'connected',
    provider: 'claude',
    revision: '1',
    kind: 'vertex',
    credential: vertexCredentialFixture(credentials),
  };
}

/** A check whose Google answers with `answer`, or throws like a dead network. */
function checkWith(answer: { status: number; body: unknown } | 'network') {
  const calls: string[] = [];
  const post: TokenPost = async (url) => {
    calls.push(url);
    if (answer === 'network') throw new Error(`connect ECONNREFUSED proxy ${MARKER}`);
    return answer;
  };
  return {
    calls,
    check: givenLoginCheck((credentials) => new VertexTokens(credentials, { post })),
  };
}

describe('the given-login check', () => {
  it('passes a Vertex key Google gives a token for, asking Google once', async () => {
    const { calls, check } = checkWith({ status: 200, body: { access_token: 'ya29.OK' } });
    expect(await check(vertex())).toBe('ok');
    expect(calls).toEqual(['https://oauth2.googleapis.com/token']);
  });

  it.each([400, 401, 403])('rejects a key Google refuses (HTTP %i)', async (status) => {
    const { check } = checkWith({ status, body: { error: 'invalid_grant', echo: MARKER } });
    expect(await check(vertex())).toBe('rejected');
  });

  it('rejects a key that cannot sign the request, without asking Google', async () => {
    // The fixture's private key is a placeholder that signs nothing.
    const { calls, check } = checkWith({ status: 200, body: { access_token: 'ya29.OK' } });
    expect(await check(vertex({ ...SIGNING_KEY, private_key: 'not a key' }))).toBe('rejected');
    expect(calls).toEqual([]);
  });

  it('rejects a key naming a token endpoint other than Google’s, without asking', async () => {
    const { calls, check } = checkWith({ status: 200, body: { access_token: 'ya29.OK' } });
    expect(await check(vertex({ ...SIGNING_KEY, token_uri: 'https://example.test/token' }))).toBe(
      'rejected'
    );
    expect(calls).toEqual([]);
  });

  it.each<[string, { status: number; body: unknown } | 'network']>([
    ['the network is down', 'network'],
    ['Google has a passing fault', { status: 503, body: null }],
    ['Google says slow down', { status: 429, body: null }],
  ])('says nothing is known when %s, never ok', async (_why, answer) => {
    expect(await checkWith(answer).check(vertex())).toBe('unreachable');
  });

  it('passes logins other than Vertex without asking anyone', async () => {
    const { calls, check } = checkWith('network');
    for (const kind of ['api-key', 'setup-token'] as const)
      expect(
        await check({
          status: 'connected',
          provider: 'claude',
          revision: '1',
          kind,
          credential: 'x',
        })
      ).toBe('ok');
    expect(calls).toEqual([]);
  });

  it('rejects a Vertex login whose credential is not one', async () => {
    const { check } = checkWith({ status: 200, body: { access_token: 'ya29.OK' } });
    expect(await check({ ...vertex(), credential: '{"not":"vertex"}' })).toBe('rejected');
  });

  it('keeps everything Google said, and the key, out of what it returns and throws', async () => {
    const refused = new TokenRefused(400);
    expect(refused.message).not.toContain(MARKER);
    expect(new TokenUnreachable().message).not.toContain(MARKER);
    expect(verdictFor(refused)).toBe('rejected');
    expect(verdictFor(new TokenUnreachable())).toBe('unreachable');
    // The network error's text (which here holds the marker) is dropped.
    const post: TokenPost = async () => {
      throw new Error(MARKER);
    };
    const tokens = new VertexTokens(SIGNING_KEY as never, { post });
    await expect(tokens.token()).rejects.toThrow(TokenUnreachable);
    await expect(tokens.token()).rejects.not.toThrow(MARKER);
  });
});
