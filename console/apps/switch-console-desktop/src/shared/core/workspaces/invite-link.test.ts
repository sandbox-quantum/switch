import { describe, expect, it } from 'vitest';
import { parseInviteLink } from './invite-link';

describe('parseInviteLink', () => {
  it('reads the origin and token from a server invite link', () => {
    expect(parseInviteLink('https://switch.example.com/invite#token=abc123')).toEqual({
      origin: 'https://switch.example.com',
      token: 'abc123',
    });
  });

  it('keeps a port and tolerates surrounding whitespace and a trailing slash', () => {
    expect(parseInviteLink('  http://localhost:5173/invite/#token=t%2Bk  \n')).toEqual({
      origin: 'http://localhost:5173',
      token: 't+k',
    });
  });

  it('refuses an empty paste', () => {
    expect(() => parseInviteLink('   ')).toThrow(/Paste the invite link/);
  });

  it('refuses text that is not a link', () => {
    expect(() => parseInviteLink('abc123')).toThrow(/not a link/);
  });

  it('refuses a link that is not an http one', () => {
    expect(() => parseInviteLink('ftp://switch.example.com/invite#token=abc')).toThrow(
      /not a link/
    );
  });

  it('refuses a link to some other page', () => {
    expect(() => parseInviteLink('https://switch.example.com/rooms#token=abc')).toThrow(
      /not an invitation/
    );
  });

  it('refuses an invite link with the token cut off', () => {
    expect(() => parseInviteLink('https://switch.example.com/invite')).toThrow(/no token/);
    expect(() => parseInviteLink('https://switch.example.com/invite#token=')).toThrow(/no token/);
  });
});
