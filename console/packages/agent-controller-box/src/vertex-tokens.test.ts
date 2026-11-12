import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { GoogleCredentials } from '@switch-console/agent-providers-box';
import { describe, expect, it } from 'vitest';
import {
  MAX_TOKEN_LIFETIME_S,
  RENEW_BEFORE_MS,
  type TokenPost,
  VERTEX_SCOPE,
  VertexTokens,
} from './vertex-tokens';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const SERVICE_ACCOUNT = {
  type: 'service_account',
  client_email: 'claude-vertex@test-project.iam.gserviceaccount.com',
  private_key: PRIVATE_PEM,
  private_key_id: 'key-1',
  token_uri: 'https://oauth2.googleapis.com/token',
} as GoogleCredentials;

const AUTHORIZED_USER = {
  type: 'authorized_user',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'client-secret',
  refresh_token: 'refresh-token',
} as GoogleCredentials;

function stub(answers: { status: number; body: unknown }[]) {
  const calls: { url: string; form: Record<string, string> }[] = [];
  const post: TokenPost = async (url, form) => {
    calls.push({ url, form });
    return answers.shift() ?? { status: 500, body: null };
  };
  return { calls, post };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('a service account key', () => {
  it('buys a token with an RS256 assertion Google can check', async () => {
    const clock = 1_800_000_000_000;
    const { calls, post } = stub([
      { status: 200, body: { access_token: 'ya29.ONE', expires_in: 3599 } },
    ]);
    const tokens = new VertexTokens(SERVICE_ACCOUNT, { post, now: () => clock });
    expect(await tokens.credential()).toEqual({
      header: 'authorization',
      value: 'Bearer ya29.ONE',
    });
    expect(calls).toHaveLength(1);
    const { url, form } = calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [head, body, signature] = form.assertion!.split('.');
    expect(decode(head!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-1' });
    expect(decode(body!)).toEqual({
      iss: 'claude-vertex@test-project.iam.gserviceaccount.com',
      scope: VERTEX_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: clock / 1000,
      exp: clock / 1000 + 3600,
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(valid).toBe(true);
    // The key itself is never sent.
    expect(JSON.stringify(form)).not.toContain('PRIVATE KEY');
  });

  it('keeps the token until shortly before it expires, then buys another', async () => {
    let clock = 1_800_000_000_000;
    const { calls, post } = stub([
      { status: 200, body: { access_token: 'ya29.ONE', expires_in: 3600 } },
      { status: 200, body: { access_token: 'ya29.TWO', expires_in: 3600 } },
    ]);
    const tokens = new VertexTokens(SERVICE_ACCOUNT, { post, now: () => clock });
    expect(await tokens.token()).toBe('ya29.ONE');
    clock += 3600_000 - RENEW_BEFORE_MS - 1000;
    expect(await tokens.token()).toBe('ya29.ONE');
    expect(calls).toHaveLength(1);
    clock += 2000;
    expect(await tokens.token()).toBe('ya29.TWO');
    expect(calls).toHaveLength(2);
  });

  it('serves every call that arrives during an exchange with that one exchange', async () => {
    let release: () => void = () => {};
    const calls: unknown[] = [];
    const post: TokenPost = async () => {
      calls.push(1);
      await new Promise<void>((r) => (release = r));
      return { status: 200, body: { access_token: 'ya29.SHARED', expires_in: 3600 } };
    };
    const tokens = new VertexTokens(SERVICE_ACCOUNT, { post });
    const all = Promise.all([tokens.token(), tokens.token(), tokens.token()]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await all).toEqual(['ya29.SHARED', 'ya29.SHARED', 'ya29.SHARED']);
    expect(calls).toHaveLength(1);
  });
});

describe('a user’s application-default sign-in', () => {
  it('buys a token with its refresh token', async () => {
    const { calls, post } = stub([
      { status: 200, body: { access_token: 'ya29.USER', expires_in: 3599 } },
    ]);
    const tokens = new VertexTokens(AUTHORIZED_USER, { post });
    expect(await tokens.token()).toBe('ya29.USER');
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]!.form).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client.apps.googleusercontent.com',
      client_secret: 'client-secret',
      refresh_token: 'refresh-token',
    });
  });
});

describe('when Google says no', () => {
  it('fails with the status only, never Google’s answer, and tries again next time', async () => {
    const { calls, post } = stub([
      { status: 400, body: { error: 'invalid_grant', error_description: 'echoes refresh-token' } },
      { status: 200, body: { access_token: 'ya29.LATER', expires_in: 3600 } },
    ]);
    const tokens = new VertexTokens(AUTHORIZED_USER, { post });
    await expect(tokens.token()).rejects.toThrow(
      'Google refused the Vertex token exchange (HTTP 400).'
    );
    await expect(tokens.token()).resolves.toBe('ya29.LATER');
    expect(calls).toHaveLength(2);
  });

  it('a cleared token is bought again', async () => {
    const { calls, post } = stub([
      { status: 200, body: { access_token: 'ya29.ONE', expires_in: 3600 } },
      { status: 200, body: { access_token: 'ya29.TWO', expires_in: 3600 } },
    ]);
    const tokens = new VertexTokens(SERVICE_ACCOUNT, { post });
    expect(await tokens.token()).toBe('ya29.ONE');
    tokens.clear();
    expect(await tokens.token()).toBe('ya29.TWO');
    expect(calls).toHaveLength(2);
  });
});

describe('what it trusts', () => {
  it('sends a credential to Google’s token endpoint only, whatever the file names', async () => {
    const { calls, post } = stub([
      { status: 200, body: { access_token: 'ya29.NEVER', expires_in: 3600 } },
    ]);
    const tokens = new VertexTokens(
      { ...SERVICE_ACCOUNT, token_uri: 'https://attacker.example/token' } as GoogleCredentials,
      { post }
    );
    await expect(tokens.token()).rejects.toThrow('token endpoint other than Google’s');
    expect(calls).toHaveLength(0);
  });

  it('keeps a token an hour at most, whatever Google says', async () => {
    let clock = 1_800_000_000_000;
    const { calls, post } = stub([
      { status: 200, body: { access_token: 'ya29.LONG', expires_in: 86_400 } },
      { status: 200, body: { access_token: 'ya29.NEXT', expires_in: 3600 } },
    ]);
    const tokens = new VertexTokens(SERVICE_ACCOUNT, { post, now: () => clock });
    expect(await tokens.token()).toBe('ya29.LONG');
    clock += MAX_TOKEN_LIFETIME_S * 1000 - RENEW_BEFORE_MS + 1000;
    expect(await tokens.token()).toBe('ya29.NEXT');
    expect(calls).toHaveLength(2);
  });

  /** A token endpoint whose answers wait until the test releases them, in any order. */
  function held() {
    const releases: (() => void)[] = [];
    let posts = 0;
    const post: TokenPost = async () => {
      const mine = ++posts;
      await new Promise<void>((r) => releases.push(r));
      return { status: 200, body: { access_token: `ya29.T${mine}`, expires_in: 3600 } };
    };
    return { releases, post, posts: () => posts };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('never keeps a token from an exchange that started before clear(), even if it ends last', async () => {
    const google = held();
    const tokens = new VertexTokens(SERVICE_ACCOUNT, { post: google.post });
    const before = tokens.token();
    await tick();
    tokens.clear();
    const after = tokens.token();
    await tick();
    expect(google.releases).toHaveLength(2);
    google.releases[1]!();
    expect(await after).toBe('ya29.T2');
    google.releases[0]!();
    expect(await before).toBe('ya29.T1');
    expect(await tokens.token()).toBe('ya29.T2');
    expect(google.posts()).toBe(2);
  });

  it('an exchange from before clear() ending first doesn’t cut short the one after it', async () => {
    const google = held();
    const tokens = new VertexTokens(SERVICE_ACCOUNT, { post: google.post });
    const before = tokens.token();
    await tick();
    tokens.clear();
    const after = tokens.token();
    await tick();
    google.releases[0]!();
    expect(await before).toBe('ya29.T1');
    // A call now joins the exchange still running, rather than starting a third.
    const joined = tokens.token();
    await tick();
    expect(google.posts()).toBe(2);
    google.releases[1]!();
    expect(await after).toBe('ya29.T2');
    expect(await joined).toBe('ya29.T2');
  });
});
