import { describe, expect, it } from 'vitest';
import type {
  StackConsole,
  StackRegister,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  activitySentence,
  affectedSentence,
  describeConsole,
  othersRecentlySeen,
  sharedWithSentence,
} from './shared-consoles';

const NOW = new Date('2026-09-23T12:00:00.000Z');

function seen(name: string, hoursAgo: number, id = name): StackConsole {
  return {
    consoleId: id,
    name,
    hostAccount: name.split('@')[0]!,
    appVersion: '0.36.0',
    lastSeenAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  };
}

function register(consoles: StackConsole[], self = 'me'): StackRegister {
  return { self, consoles, activity: [] };
}

describe('othersRecentlySeen', () => {
  it('leaves out this Console and anyone not seen for a fortnight', () => {
    const others = othersRecentlySeen(
      register([seen('me@laptop', 0, 'me'), seen('bob@desk', 2), seen('carol@old', 24 * 15)]),
      NOW
    );

    expect(others.map((c) => c.name)).toEqual(['bob@desk']);
  });

  it('is empty before anything has been read', () => {
    expect(othersRecentlySeen(null, NOW)).toEqual([]);
  });

  it('does not count an entry whose time it cannot read', () => {
    const others = othersRecentlySeen(
      register([{ ...seen('bob@desk', 1), lastSeenAt: 'yesterday' }]),
      NOW
    );

    expect(others).toEqual([]);
  });
});

describe('the sentences', () => {
  it('names the desktop and the account it reaches the host as', () => {
    expect(describeConsole(seen('bob@desk', 1))).toBe('bob@desk (as bob)');
  });

  it('says nothing about sharing when nobody else uses the server', () => {
    expect(sharedWithSentence([])).toBeNull();
    expect(affectedSentence([], NOW)).toBeNull();
  });

  it('names one, two, or two and a count of the rest', () => {
    expect(sharedWithSentence([seen('bob@desk', 1)])).toBe(
      'Shared with bob@desk. Stopping or restarting it affects them too.'
    );
    expect(sharedWithSentence([seen('bob@desk', 1), seen('carol@lab', 2)])).toMatch(
      /^Shared with bob@desk and carol@lab\./
    );
    expect(
      sharedWithSentence([seen('bob@desk', 1), seen('carol@lab', 2), seen('dan@home', 3)])
    ).toMatch(/^Shared with bob@desk, carol@lab and 1 other\./);
  });

  it('tells a confirmation who it reaches and when they were last there', () => {
    expect(affectedSentence([seen('bob@desk', 2), seen('carol@lab', 30)], NOW)).toBe(
      'Also used recently by bob@desk (as bob), 2 hours ago; carol@lab (as carol), 1 day ago.'
    );
  });

  it('keeps a long list short', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n, i) => seen(`${n}@host`, i + 1));

    expect(affectedSentence(many, NOW)).toMatch(/; and 2 more\.$/);
  });

  it('says what happened, and says it was this Console when it was', () => {
    const entry = {
      at: NOW.toISOString(),
      action: 'stopped' as const,
      consoleId: 'bob',
      name: 'bob@desk',
      hostAccount: 'bob',
    };

    expect(activitySentence(entry, 'me')).toBe('bob@desk stopped it');
    expect(activitySentence({ ...entry, consoleId: 'me' }, 'me')).toBe('This Console stopped it');
  });
});
