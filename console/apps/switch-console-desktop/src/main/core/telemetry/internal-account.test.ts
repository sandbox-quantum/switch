import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/core/switch-servers/servers-store', () => ({
  listServers: vi.fn(),
  getSessionCookie: vi.fn(),
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
