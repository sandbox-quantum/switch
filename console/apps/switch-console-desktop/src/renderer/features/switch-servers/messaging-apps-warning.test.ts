import { describe, expect, it } from 'vitest';
import type {
  LinkedIdentity,
  PendingIdentity,
  RemoteBridge,
} from '@shared/core/switch-servers/switch-servers';
import {
  accountLinkPrompts,
  hasUnlinkedMessagingApp,
  identityLinkOrderingNote,
  linkedIdentityOn,
  shouldOfferIdentityLinkOnConnect,
  unrecognisedMessagingApps,
  unrecognisedMessagingAppsMessage,
} from './messaging-apps-warning';

function bridge(id: string, displayName: string): RemoteBridge {
  return {
    id,
    type: 'slack',
    displayName,
    status: 'active',
    isDefault: false,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
    attention: null,
    teamPlacementSupported: false,
    channelIdsRefused: null,
    receivesWebhooks: false,
    webhookUrl: null,
  };
}

function identity(bridgeId: string, verified = true): LinkedIdentity {
  return {
    id: `identity-${bridgeId}`,
    bridgeId,
    bridgeDisplayName: bridgeId,
    bridgeType: 'slack',
    externalUserId: 'U1',
    externalUsername: 'me',
    verified,
  };
}

function pendingLink(bridgeId: string): PendingIdentity {
  return {
    id: `pending-${bridgeId}`,
    bridgeId,
    bridgeDisplayName: bridgeId,
    bridgeType: 'slack',
    externalUserId: 'U1',
    externalUsername: 'me',
    requestedByName: null,
    codeExpiresAt: null,
  };
}

const slack = bridge('b-slack', 'Slack Test');
const mattermost = bridge('b-mm', 'Mattermost');
const telegram = bridge('b-tg', 'Telegram louis');

describe('unrecognisedMessagingApps', () => {
  it('names the apps with no claimed account when an owner-addressed agent is owned', () => {
    expect(
      unrecognisedMessagingApps({
        bridges: [slack, mattermost, telegram],
        identities: [identity('b-slack')],
        ownsOwnerAddressedAgent: true,
      })
    ).toEqual([mattermost, telegram]);
  });

  it('stays quiet when every app is linked', () => {
    expect(
      unrecognisedMessagingApps({
        bridges: [slack, mattermost],
        identities: [identity('b-slack'), identity('b-mm')],
        ownsOwnerAddressedAgent: true,
      })
    ).toEqual([]);
  });

  it('stays quiet when the user owns no owner-addressed agent', () => {
    expect(
      unrecognisedMessagingApps({
        bridges: [slack, mattermost],
        identities: [],
        ownsOwnerAddressedAgent: false,
      })
    ).toEqual([]);
  });

  it('stays quiet while the identity list is unknown', () => {
    expect(
      unrecognisedMessagingApps({
        bridges: [slack, mattermost],
        identities: null,
        ownsOwnerAddressedAgent: true,
      })
    ).toEqual([]);
  });

  it('stays quiet while the policy probe has not answered', () => {
    expect(
      unrecognisedMessagingApps({
        bridges: [slack, mattermost],
        identities: [],
        ownsOwnerAddressedAgent: null,
      })
    ).toEqual([]);
  });

  it('stays quiet when no messaging app is connected', () => {
    expect(
      unrecognisedMessagingApps({
        bridges: [],
        identities: [],
        ownsOwnerAddressedAgent: true,
      })
    ).toEqual([]);
  });

  it('warns about a down bridge the user has not linked, as the card still offers Link there', () => {
    const down = { ...bridge('b-down', 'test'), status: 'error' };
    expect(
      unrecognisedMessagingApps({
        bridges: [down],
        identities: [],
        ownsOwnerAddressedAgent: true,
      })
    ).toEqual([down]);
  });
});

describe('hasUnlinkedMessagingApp', () => {
  it('is false while the identity list is unknown, so nothing is probed on load', () => {
    expect(hasUnlinkedMessagingApp([slack], null)).toBe(false);
  });

  it('is false when every app is linked', () => {
    expect(hasUnlinkedMessagingApp([slack], [identity('b-slack')])).toBe(false);
  });

  it('is true when one app is unlinked', () => {
    expect(hasUnlinkedMessagingApp([slack, mattermost], [identity('b-slack')])).toBe(true);
  });

  it('counts a link made before links had to be confirmed, which still works', () => {
    expect(hasUnlinkedMessagingApp([slack], [identity('b-slack', false)])).toBe(false);
  });
});

describe('unrecognisedMessagingAppsMessage', () => {
  it('names one app', () => {
    expect(unrecognisedMessagingAppsMessage([mattermost])).toBe(
      'Agents set to answer only you can’t recognise you in Mattermost — link your account there.'
    );
  });

  it('joins two apps with "or"', () => {
    expect(unrecognisedMessagingAppsMessage([mattermost, telegram])).toBe(
      'Agents set to answer only you can’t recognise you in Mattermost or Telegram louis — link your account there.'
    );
  });

  it('joins three apps with commas and a final "or"', () => {
    expect(unrecognisedMessagingAppsMessage([mattermost, telegram, bridge('b-t', 'test')])).toBe(
      'Agents set to answer only you can’t recognise you in Mattermost, Telegram louis or test — link your account there.'
    );
  });
});

describe('offering the link step after connecting an app', () => {
  it('offers it on a platform with a directory to search', () => {
    expect(shouldOfferIdentityLinkOnConnect({ directorySearchSupported: true })).toBe(true);
  });

  it('does not on one without, where the search cannot find anyone yet', () => {
    // Telegram. Switch only knows people who have messaged it, and nobody has
    // messaged a connection made a second ago — so the dialog offered a search
    // box that was guaranteed to come back empty, which reads as "you are not
    // in your own workspace" rather than "not yet".
    expect(shouldOfferIdentityLinkOnConnect({ directorySearchSupported: false })).toBe(false);
  });
});

describe('what is said instead, where the link step is withheld', () => {
  // Withholding the picker is right; withholding the reason left the user
  // waiting for a prompt that never came (CHOO-2173).
  it('says nothing where the directory can be searched', () => {
    expect(
      identityLinkOrderingNote({ displayName: 'Acme Slack', directorySearchSupported: true })
    ).toBeNull();
  });

  it('gives the ordering where it cannot, naming the app', () => {
    const note = identityLinkOrderingNote({
      displayName: 'Telegram louis',
      directorySearchSupported: false,
    });

    expect(note).toContain('Telegram louis');
    // Be seen first, link second — the part that cannot be guessed.
    expect(note).toContain('Send a message in a connected group');
    expect(note).toContain('link your account');
  });

  it('never contradicts the decision not to offer the step', () => {
    // The two must agree: an app that is offered the picker is not also told
    // to come back later, and one that is withheld is always told why.
    for (const directorySearchSupported of [true, false]) {
      const offered = shouldOfferIdentityLinkOnConnect({ directorySearchSupported });
      const note = identityLinkOrderingNote({ displayName: 'X', directorySearchSupported });
      expect(offered).toBe(note === null);
    }
  });
});

describe('accountLinkPrompts', () => {
  const slack = bridge('b-slack', 'Slack');
  const discord = bridge('b-discord', 'Discord');

  it('asks to link every active app with nothing linked or waiting', () => {
    expect(accountLinkPrompts([slack, discord], [identity('b-discord')], [])).toEqual([
      { kind: 'link', bridge: slack },
    ]);
  });

  it('asks nothing once every app is linked and confirmed', () => {
    expect(accountLinkPrompts([slack], [identity('b-slack')], [])).toEqual([]);
  });

  it('asks nothing while the linked accounts are unknown', () => {
    expect(accountLinkPrompts([slack], null, [])).toEqual([]);
  });

  it('leaves out a connection that is down', () => {
    expect(accountLinkPrompts([{ ...slack, status: 'error' }], [], [])).toEqual([]);
  });

  it('says a link is waiting for its code rather than asking for it again', () => {
    const waiting = pendingLink('b-slack');

    expect(accountLinkPrompts([slack], [], [waiting])).toEqual([
      { kind: 'pending', bridge: slack, link: waiting },
    ]);
  });

  it('still asks to link when the pending links are unknown or failed to load', () => {
    // Withholding the prompt until the pending list arrives would withhold it
    // for good on a server where that read fails.
    expect(accountLinkPrompts([slack], [], null)).toEqual([{ kind: 'link', bridge: slack }]);
  });

  it('asks to confirm a link made before links had to be confirmed', () => {
    const old = identity('b-slack', false);

    expect(accountLinkPrompts([slack], [old], null)).toEqual([
      { kind: 'unverified', bridge: slack, identity: old },
    ]);
  });

  it('asks nothing of an app with one confirmed link, whatever else is there', () => {
    expect(
      accountLinkPrompts(
        [slack],
        [identity('b-slack', false), { ...identity('b-slack'), id: 'other' }],
        [pendingLink('b-slack')]
      )
    ).toEqual([]);
  });
});

describe('linkedIdentityOn', () => {
  const unconfirmed = { ...identity('b-slack', false), id: 'old', externalUsername: 'old' };
  const confirmed = { ...identity('b-slack'), id: 'new', externalUsername: 'new' };

  it('shows a confirmed account over an unconfirmed one, in either order', () => {
    // Otherwise the row would say "Not confirmed" under a prompt that is
    // satisfied, since the prompt asks whether any link is confirmed.
    expect(linkedIdentityOn('b-slack', [unconfirmed, confirmed])).toBe(confirmed);
    expect(linkedIdentityOn('b-slack', [confirmed, unconfirmed])).toBe(confirmed);
  });

  it('falls back to an unconfirmed account, which still counts', () => {
    expect(linkedIdentityOn('b-slack', [unconfirmed])).toBe(unconfirmed);
  });

  it('is null for an app with nothing linked', () => {
    expect(linkedIdentityOn('b-mm', [confirmed])).toBeNull();
  });
});
