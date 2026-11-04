import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { buddyPlatform, buddySetupCardsEnabled, buddySetupStep } from './buddy-setup-step';

const slack = { id: 'b-1', type: 'slack', status: 'active' } as RemoteBridge;
const slack2 = { id: 'b-2', type: 'slack', status: 'active' } as RemoteBridge;
const teams = {
  id: 'b-3',
  type: 'teams',
  status: 'active',
  directorySearchSupported: true,
} as RemoteBridge;
const telegram = {
  id: 'b-4',
  type: 'telegram',
  status: 'active',
  directorySearchSupported: false,
} as RemoteBridge;
const linked = { bridgeId: 'b-1' } as LinkedIdentity;
const linked2 = { bridgeId: 'b-2' } as LinkedIdentity;
const handedOff = { roomId: 'r-2', channelType: 'direct', bridgeType: 'slack' } as ChatSummary;

const base = {
  platform: 'slack' as const,
  bridges: [],
  identities: [],
  resumes: {},
  failed: false,
};

describe('buddySetupCardsEnabled', () => {
  it('is on only when the server turns the flag on', () => {
    expect(buddySetupCardsEnabled(undefined)).toBe(false);
    expect(buddySetupCardsEnabled({})).toBe(false);
    expect(buddySetupCardsEnabled({ buddy_slack_handoff: false })).toBe(false);
    expect(buddySetupCardsEnabled({ buddy_slack_handoff: true })).toBe(true);
  });
});

describe('buddySetupStep', () => {
  it('waits for the reads, and says unknown when one failed, never not connected', () => {
    expect(buddySetupStep({ ...base, bridges: null })).toEqual({ kind: 'loading' });
    expect(buddySetupStep({ ...base, bridges: null, failed: true })).toEqual({ kind: 'unknown' });
  });

  it('walks connect, link, resuming, create', () => {
    expect(buddySetupStep(base)).toEqual({ kind: 'connect', platform: 'slack' });
    expect(buddySetupStep({ ...base, bridges: [{ ...slack, status: 'error' }] }).kind).toBe(
      'connect'
    );
    expect(buddySetupStep({ ...base, bridges: [slack], identities: null })).toEqual({
      kind: 'loading',
    });
    expect(buddySetupStep({ ...base, bridges: [slack] })).toEqual({ kind: 'link', bridge: slack });
    expect(buddySetupStep({ ...base, bridges: [slack], identities: [linked] })).toEqual({
      kind: 'resuming',
    });
    expect(
      buddySetupStep({ ...base, bridges: [slack], identities: [linked], resumes: { 'b-1': null } })
    ).toEqual({ kind: 'create', bridge: slack });
  });

  it('offers to create, never assumes, when no hand-off was started, even with a Slack chat made by hand', () => {
    expect(
      buddySetupStep({
        ...base,
        bridges: [slack, slack2],
        identities: [linked, linked2],
        resumes: { 'b-1': null, 'b-2': null },
      })
    ).toEqual({ kind: 'create', bridge: slack });
  });

  it('is done with the room of the hand-off on whichever connection made it', () => {
    expect(
      buddySetupStep({
        ...base,
        bridges: [slack, slack2],
        identities: [linked, linked2],
        resumes: { 'b-1': null, 'b-2': handedOff },
      })
    ).toEqual({ kind: 'done', chat: handedOff });
  });

  it('says unknown when a resume failed', () => {
    expect(
      buddySetupStep({
        ...base,
        bridges: [slack],
        identities: [linked],
        resumes: { 'b-1': 'failed' },
      })
    ).toEqual({ kind: 'unknown' });
  });

  it('asks for a choice when none was made and nothing is connected', () => {
    expect(buddySetupStep({ ...base, platform: null })).toEqual({ kind: 'choose' });
  });

  it('walks Teams through connect and link to guidance, never a Slack hand-off', () => {
    const teamsBase = { ...base, platform: 'teams' as const, bridges: [slack] };
    expect(buddySetupStep(teamsBase)).toEqual({ kind: 'connect', platform: 'teams' });
    expect(buddySetupStep({ ...teamsBase, bridges: [slack, teams] })).toEqual({
      kind: 'link',
      bridge: teams,
    });
    expect(
      buddySetupStep({
        ...teamsBase,
        bridges: [slack, teams],
        identities: [{ bridgeId: 'b-3' } as LinkedIdentity],
      })
    ).toEqual({ kind: 'guide', bridge: teams });
  });

  it('guides Telegram only once linked, since the buddy ignores anyone it cannot recognise', () => {
    const telegramBase = { ...base, platform: 'telegram' as const };
    expect(buddySetupStep(telegramBase)).toEqual({ kind: 'connect', platform: 'telegram' });
    expect(buddySetupStep({ ...telegramBase, bridges: [telegram] })).toEqual({
      kind: 'link',
      bridge: telegram,
    });
    expect(
      buddySetupStep({
        ...telegramBase,
        bridges: [telegram],
        identities: [{ bridgeId: 'b-4' } as LinkedIdentity],
      })
    ).toEqual({ kind: 'guide', bridge: telegram });
  });
});

describe('buddyPlatform', () => {
  it('is the one picked, else the first app already connected', () => {
    expect(buddyPlatform('teams', [slack])).toBe('teams');
    expect(buddyPlatform(null, null)).toBe(null);
    expect(buddyPlatform(null, [])).toBe(null);
    expect(buddyPlatform(null, [telegram, teams])).toBe('teams');
    expect(buddyPlatform(null, [{ ...slack, status: 'error' }, telegram])).toBe('telegram');
  });
});
