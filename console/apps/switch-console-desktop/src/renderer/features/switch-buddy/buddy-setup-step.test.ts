import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { buddySetupCardsEnabled, buddySetupStep } from './buddy-setup-step';

const slack = { id: 'b-1', type: 'slack', status: 'active' } as RemoteBridge;
const slack2 = { id: 'b-2', type: 'slack', status: 'active' } as RemoteBridge;
const linked = { bridgeId: 'b-1' } as LinkedIdentity;
const linked2 = { bridgeId: 'b-2' } as LinkedIdentity;
const handedOff = { roomId: 'r-2', channelType: 'direct', bridgeType: 'slack' } as ChatSummary;

const base = { bridges: [], identities: [], resumes: {}, failed: false };

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
    expect(buddySetupStep(base)).toEqual({ kind: 'connect' });
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
});
