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

  it("leaves out a CLI's own callback server and the full stop after a link", () => {
    expect(
      linksIn([
        'Starting local login server on http://localhost:1455.',
        'If your browser did not open, navigate to this URL to authenticate:',
        'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455',
        'or see https://example.com/help.',
      ])
    ).toEqual([
      'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455',
      'https://example.com/help',
    ]);
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
