import { describe, expect, it } from 'vitest';
import { connectedAppsSummary, LINK_ACCOUNTS_LATER, spellCount } from './link-accounts-prose';

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
