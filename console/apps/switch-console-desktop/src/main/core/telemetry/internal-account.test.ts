import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/kv', () => ({
  KV: class {
    private values = new Map<string, unknown>();
    async get(key: string) {
      return this.values.get(key) ?? null;
    }
    async set(key: string, value: unknown) {
      this.values.set(key, structuredClone(value));
    }
  },
}));

const { emailFromJwt, internalFrom, isInternalEmail } = await import('./internal-account');

function jwtWith(payload: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part(payload)}.signature`;
}

describe('whether an account is staff', () => {
  it.each([
    'someone@sandboxaq.com',
    'someone@sandboxquantum.com',
    'Someone@SandboxAQ.com',
    'someone@eng.sandboxaq.com',
  ])('counts %s', (email) => {
    expect(isInternalEmail(email)).toBe(true);
  });

  it.each(['someone@example.com', 'someone@notsandboxaq.com', 'someone@sandboxaq.com.evil'])(
    'does not count %s',
    (email) => {
      expect(isInternalEmail(email)).toBe(false);
    }
  );
});

describe('whether the person is staff', () => {
  it('is true when any account is', () => {
    expect(internalFrom(['someone@example.com', 'someone@sandboxaq.com'])).toBe('true');
  });

  it('is false when only outside accounts are signed in', () => {
    expect(internalFrom(['someone@example.com', null])).toBe('false');
  });

  it('is unknown when no account says, including the one a local server signs in with', () => {
    expect(internalFrom([])).toBe('unknown');
    expect(internalFrom([null, 'admin@switch.local'])).toBe('unknown');
  });
});

describe('reading the account from a session', () => {
  it('reads the email claim', () => {
    expect(emailFromJwt(jwtWith({ sub: 'u1', email: 'someone@sandboxaq.com' }))).toBe(
      'someone@sandboxaq.com'
    );
  });

  it('reads nothing from a malformed token or one without the claim', () => {
    expect(emailFromJwt('not-a-jwt')).toBeNull();
    expect(emailFromJwt(jwtWith({ sub: 'u1' }))).toBeNull();
  });
});

describe('the answer kept beside each session', () => {
  // A fresh module per test: the answers live in the module's store, and one
  // test's staff sign-in would otherwise make every later one internal.
  async function fresh() {
    vi.resetModules();
    return import('./internal-account');
  }

  it('is recorded when a session is stored, and forgotten when it goes', async () => {
    const accounts = await fresh();
    expect(await accounts.currentInternalFlag()).toBe('unknown');

    await accounts.recordSessionAccount('outside', jwtWith({ email: 'someone@example.com' }));
    expect(await accounts.currentInternalFlag()).toBe('false');

    await accounts.forgetSessionAccount('outside');
    expect(await accounts.currentInternalFlag()).toBe('unknown');
  });

  it('follows a server signed in again as someone else', async () => {
    const accounts = await fresh();
    await accounts.recordSessionAccount('server', jwtWith({ email: 'someone@example.com' }));
    await accounts.recordSessionAccount('server', jwtWith({ email: 'other@example.org' }));

    expect(await accounts.currentInternalFlag()).toBe('false');
  });

  it('stays internal once a staff account has signed in, after that session goes', async () => {
    // Staff who sign out, or whose session lapses, are still staff using this
    // installation; dropping back would count them as a customer.
    const accounts = await fresh();
    await accounts.recordSessionAccount('outside', jwtWith({ email: 'someone@example.com' }));
    await accounts.recordSessionAccount('staff', jwtWith({ email: 'someone@sandboxaq.com' }));
    expect(await accounts.currentInternalFlag()).toBe('true');

    await accounts.forgetSessionAccount('staff');
    expect(await accounts.currentInternalFlag()).toBe('true');

    await accounts.recordSessionAccount('staff', jwtWith({ email: 'someone@example.com' }));
    await accounts.forgetSessionAccount('outside');
    expect(await accounts.currentInternalFlag()).toBe('true');
  });
});
