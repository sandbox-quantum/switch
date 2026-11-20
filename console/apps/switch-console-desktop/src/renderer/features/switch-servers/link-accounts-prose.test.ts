import { describe, expect, it } from 'vitest';
import { handleOf } from '@renderer/lib/components/bridge-tile';
import type { LinkCode } from '@shared/core/switch-servers/switch-servers';
import {
  accountName,
  commandToPost,
  connectedAppsSummary,
  LINK_ACCOUNTS_LATER,
  spellCount,
} from './link-accounts-prose';

describe('connectedAppsSummary', () => {
  it('names the server and counts its apps in words', () => {
    expect(connectedAppsSummary('Pilot', 3)).toBe('Pilot has three messaging apps connected.');
  });

  it('agrees with a single app', () => {
    expect(connectedAppsSummary('Pilot', 1)).toBe('Pilot has one messaging app connected.');
  });

  it('says a server with none has none, rather than counting zero apps', () => {
    expect(connectedAppsSummary('Pilot', 0)).toBe('Pilot has no messaging apps connected yet.');
  });

  it('falls back to the numeral past the words it knows', () => {
    expect(spellCount(9)).toBe('nine');
    expect(connectedAppsSummary('Pilot', 12)).toBe('Pilot has 12 messaging apps connected.');
  });
});

describe('LINK_ACCOUNTS_LATER', () => {
  // The mock said rooms on an unlinked app are read-only. They are not — an
  // unlinked account only costs you owner-restricted agents recognising you,
  // and promising a lock that does not exist is the kind of claim a user finds
  // out is false the first time they type in one of those rooms.
  it('does not claim an unlinked app locks you out', () => {
    expect(LINK_ACCOUNTS_LATER).not.toMatch(/read-only/i);
    expect(LINK_ACCOUNTS_LATER).toMatch(/only their owner/);
  });
});

function linkCode(instructions: string): LinkCode {
  return { code: 'AB12-CD34', expiresAt: '', expiresInSeconds: 600, instructions, prompt: null };
}

describe('commandToPost', () => {
  it('is the command the instructions say to post', () => {
    expect(
      commandToPost(linkCode('Post `!link-account AB12-CD34` from that account in any channel.'))
    ).toBe('!link-account AB12-CD34');
  });

  it("follows the platform's own form", () => {
    expect(commandToPost(linkCode('Send `/link_account AB12-CD34` to the bot.'))).toBe(
      '/link_account AB12-CD34'
    );
  });

  it('skips inline code that does not carry the code', () => {
    expect(
      commandToPost(linkCode('In `#general`, post `!link-account AB12-CD34` from that account.'))
    ).toBe('!link-account AB12-CD34');
  });

  it('is the code alone when the instructions name no command', () => {
    expect(commandToPost(linkCode('Post the code from that account.'))).toBe('AB12-CD34');
    expect(commandToPost(linkCode('Post `the code` from that account.'))).toBe('AB12-CD34');
  });

  it('is the code alone when the backticks are unbalanced', () => {
    expect(commandToPost(linkCode('Post `!link-account AB12-CD34 from that account.'))).toBe(
      'AB12-CD34'
    );
  });
});

describe('naming a linked account', () => {
  const telegram = {
    id: 'eu-42',
    bridgeId: 'b-tg',
    bridgeDisplayName: 'Telegram',
    bridgeType: 'telegram',
    externalUserId: '42',
    externalUsername: 'MM_42',
    externalDisplayName: 'M M',
    hasHandle: false,
    verified: true,
  };

  it('uses the person’s name where Switch made up the handle', () => {
    expect(accountName(telegram)).toBe('M M');
    expect(handleOf(telegram)).toBe('M M');
  });

  it('uses the handle otherwise, and for a server that predates the name', () => {
    expect(
      accountName({ externalUsername: 'ada', externalDisplayName: 'Ada', hasHandle: true })
    ).toBe('@ada');
    expect(accountName({ externalUsername: 'ada' })).toBe('@ada');
    expect(handleOf({ ...telegram, externalUsername: 'ada', hasHandle: undefined })).toBe('@ada');
  });
});
