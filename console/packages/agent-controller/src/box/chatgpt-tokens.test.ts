import { describe, expect, it } from 'vitest';
import type { Logger } from '../log';
import type { GivenLogin } from '../sealed-logins';
import { FAKE_ACCOUNT, fakeAccessToken, fakeChatgptSignIn } from '../testing/chatgpt-sign-in';
import {
  CHATGPT_TOKEN_URL,
  ChatgptRefreshRefused,
  ChatgptTokenCache,
  ChatgptTokens,
  CODEX_CLIENT_ID,
  LoginReplaced,
  parseChatgptSignIn,
  RENEW_BEFORE_MS,
  type SaveLogin,
} from './chatgpt-tokens';

const NOW = Date.parse('2026-06-01T12:00:00Z');

function given(credential: string, revision = '1'): GivenLogin {
  return { status: 'connected', provider: 'codex', revision, kind: 'auth-json', credential };
}

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const keep = (message: string, fields?: Record<string, unknown>) =>
    lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
  return { lines, debug: keep, info: keep, warn: keep, error: keep };
}

/** A token endpoint that rotates: each refresh token works once, and gets the next. */
function rotatingEndpoint(options: { delayMs?: number } = {}) {
  const posts: { url: string; form: Record<string, string> }[] = [];
  let issued = 1;
  const valid = new Set(['rt-1']);
  return {
    posts,
    post: async (url: string, form: Record<string, string>) => {
      posts.push({ url, form });
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (!valid.delete(form.refresh_token!))
        return { status: 401, body: { error: { code: 'refresh_token_reused' } } };
      issued += 1;
      valid.add(`rt-${issued}`);
      return {
        status: 200,
        body: {
          access_token: fakeAccessToken(NOW + 3_600_000, `fresh-${issued}`),
          refresh_token: `rt-${issued}`,
          id_token: 'ignored-id-token-shape',
        },
      };
    },
  };
}

function savesInto(saved: { replaces: string; credential: string }[]): SaveLogin {
  let revision = 1;
  return async (_provider, replaces, credential) => {
    saved.push({ replaces, credential });
    revision += 1;
    return String(revision);
  };
}

describe('a ChatGPT sign-in', () => {
  it('is only a sign-in file holding ChatGPT tokens from OpenAI', () => {
    expect(parseChatgptSignIn(fakeChatgptSignIn({ expMs: NOW }))).not.toBeNull();
    // The account may be only in the id token, as older files have it.
    expect(
      parseChatgptSignIn(fakeChatgptSignIn({ expMs: NOW, accountInTokens: false }))
    ).not.toBeNull();
    const other = JSON.parse(fakeChatgptSignIn({ expMs: NOW }));
    other.tokens.oauth_provenance = { issuer: 'https://login.example.com', client_id: 'x' };
    for (const credential of [
      JSON.stringify(other),
      JSON.stringify({ OPENAI_API_KEY: 'sk-proj-x' }),
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }),
      '[]',
      'not json',
    ])
      expect(parseChatgptSignIn(credential)).toBeNull();
    expect(() => new ChatgptTokens(given('{}'), { save: null, log: recordingLog() })).toThrow(
      'no ChatGPT sign-in'
    );
  });

  it('adds its access token and its ChatGPT account, and keeps a live token without asking OpenAI', async () => {
    const endpoint = rotatingEndpoint();
    const signIn = fakeChatgptSignIn({ expMs: NOW + 3_600_000 });
    const tokens = new ChatgptTokens(given(signIn), {
      save: null,
      log: recordingLog(),
      post: endpoint.post,
      now: () => NOW,
    });
    expect(await tokens.credential()).toEqual({
      header: 'authorization',
      value: `Bearer ${JSON.parse(signIn).tokens.access_token}`,
      extra: { 'chatgpt-account-id': FAKE_ACCOUNT },
    });
    expect(endpoint.posts).toEqual([]);
  });
});

describe('renewing it', () => {
  it('renews the access token shortly before it expires, at OpenAI only, as Codex does', async () => {
    const endpoint = rotatingEndpoint();
    let now = NOW;
    const tokens = new ChatgptTokens(
      given(fakeChatgptSignIn({ expMs: NOW + RENEW_BEFORE_MS + 60_000, refresh: 'rt-1' })),
      { save: null, log: recordingLog(), post: endpoint.post, now: () => now }
    );
    await tokens.credential();
    expect(endpoint.posts).toHaveLength(0);
    now += 61_000;
    const renewed = await tokens.credential();
    expect(renewed.value).toBe(`Bearer ${fakeAccessToken(NOW + 3_600_000, 'fresh-2')}`);
    expect(endpoint.posts).toEqual([
      {
        url: CHATGPT_TOKEN_URL,
        form: { grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: 'rt-1' },
      },
    ]);
  });

  it('serves every call waiting meanwhile from one refresh, so a rotating token is used once', async () => {
    const endpoint = rotatingEndpoint({ delayMs: 20 });
    const saved: { replaces: string; credential: string }[] = [];
    const tokens = new ChatgptTokens(
      given(fakeChatgptSignIn({ expMs: NOW - 1, refresh: 'rt-1' })),
      {
        save: savesInto(saved),
        log: recordingLog(),
        post: endpoint.post,
        now: () => NOW,
      }
    );
    const answers = await Promise.all(Array.from({ length: 8 }, () => tokens.credential()));
    expect(endpoint.posts).toHaveLength(1);
    expect(new Set(answers.map((answer) => answer.value)).size).toBe(1);
    await tokens.settled();
    expect(saved).toHaveLength(1);
  });

  it('renews once when the backend refuses the token, and not again for a call that carried an older one', async () => {
    const endpoint = rotatingEndpoint();
    const tokens = new ChatgptTokens(
      given(fakeChatgptSignIn({ expMs: NOW + 3_600_000, refresh: 'rt-1' })),
      { save: null, log: recordingLog(), post: endpoint.post, now: () => NOW }
    );
    const refused = (await tokens.credential()).value;
    await Promise.all([tokens.rejected(refused), tokens.rejected(refused)]);
    expect(endpoint.posts).toHaveLength(1);
    const renewed = (await tokens.credential()).value;
    expect(renewed).not.toBe(refused);
    // A late refusal of the old token: already renewed, so nothing is asked.
    await tokens.rejected(refused);
    expect(endpoint.posts).toHaveLength(1);
  });

  it('keeps each rotation with Switch in place of the revision it came from, sealed as the whole file', async () => {
    const endpoint = rotatingEndpoint();
    const saved: { replaces: string; credential: string }[] = [];
    let now = NOW;
    const original = JSON.parse(fakeChatgptSignIn({ expMs: NOW - 1, refresh: 'rt-1' }));
    original.tokens.login_owner_id = 'kept-as-is';
    const tokens = new ChatgptTokens(given(JSON.stringify(original), '7'), {
      save: savesInto(saved),
      log: recordingLog(),
      post: endpoint.post,
      now: () => now,
    });
    await tokens.credential();
    await tokens.settled();
    now += 3_600_000;
    await tokens.credential();
    await tokens.settled();
    expect(saved.map((save) => save.replaces)).toEqual(['7', '2']);
    const kept = JSON.parse(saved[1]!.credential);
    expect(kept.tokens).toMatchObject({
      refresh_token: 'rt-3',
      access_token: fakeAccessToken(NOW + 3_600_000, 'fresh-3'),
      account_id: FAKE_ACCOUNT,
      login_owner_id: 'kept-as-is',
      id_token: 'ignored-id-token-shape',
    });
    expect(kept.last_refresh).toBe(new Date(now).toISOString());
    // What Switch kept parses back as the same sign-in, at its newest rotation.
    expect(parseChatgptSignIn(saved[1]!.credential)).not.toBeNull();
  });

  it('offers a rotation Switch did not take again, and stops once Switch holds a newer login', async () => {
    const endpoint = rotatingEndpoint();
    let now = NOW;
    let failNext = true;
    const saves: string[] = [];
    const log = recordingLog();
    const tokens = new ChatgptTokens(
      given(fakeChatgptSignIn({ expMs: NOW - 1, refresh: 'rt-1' })),
      {
        save: async (_provider, replaces) => {
          saves.push(replaces);
          if (failNext) {
            failNext = false;
            throw new Error('Switch is away');
          }
          throw new LoginReplaced();
        },
        log,
        post: endpoint.post,
        now: () => now,
      }
    );
    await tokens.credential();
    await tokens.settled();
    expect(saves).toHaveLength(1);
    expect(log.lines.some((line) => line.startsWith('Could not keep a renewed'))).toBe(true);
    await tokens.credential();
    await tokens.settled();
    expect(saves).toHaveLength(1);
    now += 61_000;
    await tokens.credential();
    await tokens.settled();
    expect(saves).toHaveLength(2);
    now += 61_000;
    await tokens.credential();
    await tokens.settled();
    expect(saves).toHaveLength(2);
  });

  it('says plainly when OpenAI refuses, and never logs a token or what OpenAI said', async () => {
    const log = recordingLog();
    const tokens = new ChatgptTokens(
      given(fakeChatgptSignIn({ expMs: NOW - 1, refresh: 'rt-SECRET-REFRESH' })),
      {
        save: null,
        log,
        post: async () => ({ status: 401, body: { error: 'echo rt-SECRET-REFRESH' } }),
        now: () => NOW,
      }
    );
    await expect(tokens.credential()).rejects.toBeInstanceOf(ChatgptRefreshRefused);
    await expect(tokens.credential()).rejects.toThrow('Sign in again');
    expect(log.lines.join('\n')).not.toContain('SECRET');
    expect(log.lines.join('\n')).not.toContain('eyJ');
  });

  it('never sends a refused refresh token again, and retries after a passing error', async () => {
    let status = 503;
    let posts = 0;
    const tokens = new ChatgptTokens(given(fakeChatgptSignIn({ expMs: NOW - 1 })), {
      save: null,
      log: recordingLog(),
      post: async () => {
        posts += 1;
        return { status, body: null };
      },
      now: () => NOW,
    });
    await expect(tokens.credential()).rejects.toThrow('just now');
    status = 400;
    await expect(tokens.credential()).rejects.toBeInstanceOf(ChatgptRefreshRefused);
    await expect(tokens.credential()).rejects.toBeInstanceOf(ChatgptRefreshRefused);
    expect(posts).toBe(2);
  });

  it('a refresh started before the login was withdrawn is not kept', async () => {
    let release!: () => void;
    const saved: { replaces: string; credential: string }[] = [];
    const tokens = new ChatgptTokens(
      given(fakeChatgptSignIn({ expMs: NOW - 1, refresh: 'rt-1' })),
      {
        save: savesInto(saved),
        log: recordingLog(),
        post: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            status: 200,
            body: { access_token: fakeAccessToken(NOW + 3_600_000), refresh_token: 'rt-2' },
          };
        },
        now: () => NOW,
      }
    );
    const pending = tokens.credential();
    await new Promise((resolve) => setTimeout(resolve, 0));
    tokens.clear();
    release();
    await pending;
    await tokens.settled();
    expect(saved).toEqual([]);
  });
});

describe('one sign-in for every agent', () => {
  const make = () => {
    let made = 0;
    const cache = new ChatgptTokenCache((login) => {
      made += 1;
      return new ChatgptTokens(login, { save: null, log: recordingLog(), now: () => NOW });
    });
    return { cache, made: () => made };
  };

  it('shares one per provider, keeps it for the same sign-in Switch gives back, and replaces it for a new one', () => {
    const { cache, made } = make();
    const first = given(fakeChatgptSignIn({ expMs: NOW + 3_600_000, refresh: 'rt-1' }), '1');
    const held = cache.for(first);
    expect(cache.for(first)).toBe(held);
    expect(cache.for({ ...first, revision: '2' })).toBe(held);
    // Switch handing back an older revision after a save landed: still this sign-in.
    expect(cache.for(first)).toBe(held);
    expect(made()).toBe(1);
    const other = given(fakeChatgptSignIn({ expMs: NOW + 3_600_000, refresh: 'rt-other' }), '3');
    expect(cache.for(other)).not.toBe(held);
    expect(made()).toBe(2);
    cache.forget('codex');
    cache.for(other);
    expect(made()).toBe(3);
  });
});
