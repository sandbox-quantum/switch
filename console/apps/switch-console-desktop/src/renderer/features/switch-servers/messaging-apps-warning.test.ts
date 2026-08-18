import { describe, expect, it } from 'vitest';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import {
  hasUnlinkedMessagingApp,
  identityLinkOrderingNote,
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
  };
}

function identity(bridgeId: string): LinkedIdentity {
  return {
    id: `identity-${bridgeId}`,
    bridgeId,
    bridgeDisplayName: bridgeId,
    bridgeType: 'slack',
    externalUserId: 'U1',
    externalUsername: 'me',
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
    expect(note).toContain('send a message');
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
