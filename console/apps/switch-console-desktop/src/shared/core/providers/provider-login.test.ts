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
    expect(asksForCode(['Opening your browser to sign in…'])).toBe(false);
  });
});
