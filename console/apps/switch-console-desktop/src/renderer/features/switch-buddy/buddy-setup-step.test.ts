import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import { describe, expect, it } from 'vitest';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import {
  buddyBridge,
  buddyHandedOffPlatform,
  buddyHandoffRefusal,
  buddyPlatform,
  buddyResumeBridges,
  buddySetupCardsEnabled,
  buddySetupStep,
} from './buddy-setup-step';

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
const discord = { id: 'b-5', type: 'discord', status: 'active' } as RemoteBridge;
const linked = { bridgeId: 'b-1' } as LinkedIdentity;
const linked2 = { bridgeId: 'b-2' } as LinkedIdentity;
const handedOff = { roomId: 'r-2', channelType: 'direct', bridgeType: 'slack' } as ChatSummary;

const base = {
  platform: 'slack' as const,
  bridges: [],
  identities: [],
  resumes: {},
  chosenBridgeId: null,
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
  it('walks Discord to the same private channel hand-off as Slack, on its own connections only', () => {
    const discordBase = { ...base, platform: 'discord' as const };
    const linkedDiscord = { bridgeId: 'b-5' } as LinkedIdentity;
    expect(buddySetupStep({ ...discordBase, bridges: [slack] })).toEqual({
      kind: 'connect',
      platform: 'discord',
    });
    expect(buddySetupStep({ ...discordBase, bridges: [slack, discord] })).toEqual({
      kind: 'link',
      bridge: discord,
    });
    expect(
      buddySetupStep({
        ...discordBase,
        bridges: [slack, discord],
        identities: [linked, linkedDiscord],
        resumes: { 'b-1': handedOff, 'b-5': null },
      })
    ).toEqual({ kind: 'create', bridge: discord });
  });
});

describe('a platform with one connection linked and another not', () => {
  const mixed = { ...base, bridges: [slack, slack2], identities: [linked] };

  it('defaults to the linked one and offers to create there', () => {
    expect(buddySetupStep({ ...mixed, resumes: { 'b-1': null } })).toEqual({
      kind: 'create',
      bridge: slack,
    });
  });

  it('asks to link the unlinked one when it is chosen, and creates on the linked one when that is', () => {
    expect(buddySetupStep({ ...mixed, resumes: { 'b-1': null }, chosenBridgeId: 'b-2' })).toEqual({
      kind: 'link',
      bridge: slack2,
    });
    expect(buddySetupStep({ ...mixed, resumes: { 'b-1': null }, chosenBridgeId: 'b-1' })).toEqual({
      kind: 'create',
      bridge: slack,
    });
  });

  it('shows a hand-off made on one connection, and the other connection its own state when chosen', () => {
    const both = { ...mixed, identities: [linked, linked2] };
    expect(buddySetupStep({ ...both, resumes: { 'b-1': null, 'b-2': handedOff } })).toEqual({
      kind: 'done',
      chat: handedOff,
    });
    expect(
      buddySetupStep({ ...both, resumes: { 'b-1': null, 'b-2': handedOff }, chosenBridgeId: 'b-1' })
    ).toEqual({ kind: 'create', bridge: slack });
    expect(buddySetupStep({ ...mixed, resumes: { 'b-1': handedOff } })).toEqual({
      kind: 'done',
      chat: handedOff,
    });
  });

  it('guides Teams on the connection chosen, linked or not', () => {
    const teams2 = { ...teams, id: 'b-6' } as RemoteBridge;
    const teamsMixed = {
      ...base,
      platform: 'teams' as const,
      bridges: [teams2, teams],
      identities: [{ bridgeId: 'b-3' } as LinkedIdentity],
    };
    expect(buddySetupStep(teamsMixed)).toEqual({ kind: 'guide', bridge: teams });
    expect(buddySetupStep({ ...teamsMixed, chosenBridgeId: 'b-6' })).toEqual({
      kind: 'link',
      bridge: teams2,
    });
  });
});

describe('buddyBridge', () => {
  it('is the one chosen, else a handed-off one, else a linked one, else the first connected', () => {
    const bridges = [slack, slack2, discord];
    expect(buddyBridge('slack', bridges, [], {}, 'b-2')).toBe(slack2);
    expect(buddyBridge('slack', bridges, [], {}, 'b-5')).toBe(slack);
    expect(buddyBridge('slack', bridges, [linked2], {}, null)).toBe(slack2);
    expect(buddyBridge('slack', bridges, [linked, linked2], { 'b-2': handedOff }, null)).toBe(
      slack2
    );
    expect(buddyBridge('slack', [{ ...slack, status: 'error' }, slack2], [linked], {}, null)).toBe(
      slack2
    );
    expect(buddyBridge('teams', bridges, [], {}, null)).toBeUndefined();
  });
});

describe('buddyResumeBridges', () => {
  it('is the linked, active Slack and Discord connections', () => {
    expect(
      buddyResumeBridges(
        [slack, teams, discord, { ...slack2, status: 'error' }],
        [
          linked,
          linked2,
          { bridgeId: 'b-3' } as LinkedIdentity,
          { bridgeId: 'b-5' } as LinkedIdentity,
        ]
      )
    ).toEqual([slack, discord]);
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

describe('buddyHandedOffPlatform', () => {
  it('waits for every app to answer before naming the one handed off in', () => {
    const discordChat = { ...handedOff, bridgeType: 'discord' } as ChatSummary;
    expect(buddyHandedOffPlatform([slack, discord], { 'b-1': null })).toBe(undefined);
    expect(buddyHandedOffPlatform([slack, discord], { 'b-1': null, 'b-5': discordChat })).toBe(
      'discord'
    );
    expect(buddyHandedOffPlatform([slack, discord], { 'b-1': 'failed', 'b-5': null })).toBe(null);
    expect(buddyHandedOffPlatform([], {})).toBe(null);
  });
});

function chatApiError(apiCode: string, message: string) {
  return new RpcError({
    __switchConsoleRpcError: true,
    code: 'ChatApiError',
    message,
    data: { apiCode },
  });
}

describe('buddyHandoffRefusal', () => {
  it('is the linked-account refusals, with the server reason; null for anything else', () => {
    expect(buddyHandoffRefusal(chatApiError('ACCOUNTS_AMBIGUOUS', 'Unlink one.'))).toEqual({
      code: 'ACCOUNTS_AMBIGUOUS',
      message: 'Unlink one.',
    });
    expect(buddyHandoffRefusal(chatApiError('LINKED_ACCOUNT_CHANGED', 'Changed.'))).toEqual({
      code: 'LINKED_ACCOUNT_CHANGED',
      message: 'Changed.',
    });
    expect(buddyHandoffRefusal(chatApiError('NOT_A_MEMBER', 'No.'))).toBeNull();
    expect(buddyHandoffRefusal(new Error('down'))).toBeNull();
  });
});

describe('buddySetupStep refusals', () => {
  it('a refused resume is its own step, never done or create', () => {
    const refusal = { code: 'LINKED_ACCOUNT_CHANGED' as const, message: 'Changed.' };
    expect(
      buddySetupStep({
        ...base,
        bridges: [slack],
        identities: [linked],
        resumes: { 'b-1': refusal },
      })
    ).toEqual({ kind: 'refused', bridge: slack, refusal });
  });
});
