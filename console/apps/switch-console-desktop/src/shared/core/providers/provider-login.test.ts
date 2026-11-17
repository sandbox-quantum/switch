import { describe, expect, it } from 'vitest';
import { asksForCode, linksIn } from './provider-login';

describe('provider sign-in output', () => {
  it('finds each link once, in order', () => {
    expect(
      linksIn([
        'Open https://a.example/x to sign in',
        'or https://b.example',
        'https://a.example/x',
      ])
    ).toEqual(['https://a.example/x', 'https://b.example']);
  });

  it('notices a command waiting for a pasted code', () => {
    expect(asksForCode(['Browser didn’t open?', 'Paste code here if prompted >'])).toBe(true);
    expect(
      asksForCode([
        "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x",
      ])
    ).toBe(true);
    expect(asksForCode(['Opening your browser to sign in…'])).toBe(false);
    expect(asksForCode(['Visit https://auth.example/device?user_code=ABCD'])).toBe(false);
  });
});
