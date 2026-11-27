/**
 * Made-up Codex ChatGPT sign-ins for tests: unsigned JWTs with an expiry and
 * a ChatGPT account, in the shape `codex login` writes `auth.json`. Nothing
 * here is a real token.
 */

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT carrying `claims`. */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.sig`;
}

export const FAKE_ACCOUNT = 'acct-fake-0001';

/** An access token for the fake account that expires at `expMs`. */
export function fakeAccessToken(expMs: number, marker = 'A'): string {
  return fakeJwt({
    exp: Math.floor(expMs / 1000),
    marker,
    'https://api.openai.com/auth': { chatgpt_account_id: FAKE_ACCOUNT },
  });
}

/** `auth.json` as `codex login` writes it after a ChatGPT sign-in. */
export function fakeChatgptSignIn(options: {
  expMs: number;
  refresh?: string;
  marker?: string;
  accountInTokens?: boolean;
}): string {
  const idToken = fakeJwt({
    email: 'someone@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: FAKE_ACCOUNT, chatgpt_plan_type: 'plus' },
  });
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: fakeAccessToken(options.expMs, options.marker),
      refresh_token: options.refresh ?? 'rt-fake-1',
      ...(options.accountInTokens === false ? {} : { account_id: FAKE_ACCOUNT }),
    },
    last_refresh: '2026-01-01T00:00:00Z',
  });
}
