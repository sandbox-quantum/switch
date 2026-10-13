import { describe, expect, it } from 'vitest';
import {
  AVATAR_CHOICE_COUNT,
  agentAvatarChoices,
  agentAvatarUrlForName,
  agentAvatarUrlForSeed,
  agentInitials,
  isThirdPartyAvatarUrl,
  randomAgentAvatarUrl,
  resolveAgentAvatarSrc,
} from './agent-avatar';

describe('randomAgentAvatarUrl', () => {
  it('draws a different face each time', () => {
    // A new agent opens on one of these, so two agents created in a row must
    // not look alike.
    const urls = new Set(Array.from({ length: 20 }, randomAgentAvatarUrl));
    expect(urls.size).toBe(20);
  });

  it('is an ordinary avatar URL once drawn', () => {
    expect(randomAgentAvatarUrl()).toContain('/gaze/png?');
  });
});

describe('agentAvatarUrlForSeed', () => {
  it('is stable for a seed', () => {
    // The whole scheme rests on this: an agent's generated avatar is stored
    // nowhere, so the same seed has to redraw the same face forever.
    expect(agentAvatarUrlForSeed('worker')).toBe(agentAvatarUrlForSeed('worker'));
  });

  it('differs between seeds', () => {
    expect(agentAvatarUrlForSeed('worker')).not.toBe(agentAvatarUrlForSeed('manager'));
  });

  it('asks for a raster image, not a vector one', () => {
    // Slack, Discord and Mattermost are handed this exact URL as the agent's
    // avatar and none of them render SVG. An `svg` here would look right in
    // the app and show nothing on any chat platform.
    expect(agentAvatarUrlForSeed('worker')).toContain('/gaze/png?');
    expect(agentAvatarUrlForSeed('worker')).not.toContain('/svg');
  });

  it('pins the drawing version', () => {
    // Unpinned, every stored icon silently becomes a different face the day the
    // service ships a new major.
    expect(agentAvatarUrlForSeed('worker')).toContain('/10.x/');
  });

  it('matches the URL the Switch server generates for the same seed', () => {
    // The server's test (`core/tests/switch_core/test_agent_icon.py`) pins this
    // same string. Drift between the two and an agent with no icon stored wears
    // one face here and another on every chat platform.
    expect(agentAvatarUrlForSeed('pm-agent')).toBe(
      'https://api.dicebear.com/10.x/gaze/png?seed=pm-agent&size=256&scale=1.1'
    );
  });

  it('stays short enough for Slack with a UUID seed', () => {
    // Slack refuses a whole post whose icon URL is over 255 characters, and
    // the server adds a background parameter of about 25 more on the way.
    expect(agentAvatarUrlForSeed(crypto.randomUUID()).length).toBeLessThan(200);
  });

  it('escapes a seed that would otherwise break the query string', () => {
    const url = agentAvatarUrlForSeed('a&b=c d');
    expect(url).toContain('seed=a%26b%3Dc+d');
    // One `?`, and the seed cannot introduce parameters of its own.
    expect(url.split('?')).toHaveLength(2);
  });
});

describe('agentAvatarChoices', () => {
  it('leads with the avatar the agent already has', () => {
    // The first tile is the one the agent is currently wearing, so the grid
    // opens showing the status quo rather than ten alternatives to it.
    expect(agentAvatarChoices('worker', 0)[0]).toBe(agentAvatarUrlForName('worker'));
  });

  it('offers a full page of distinct choices', () => {
    const choices = agentAvatarChoices('worker', 0);
    expect(choices).toHaveLength(AVATAR_CHOICE_COUNT);
    expect(new Set(choices).size).toBe(AVATAR_CHOICE_COUNT);
  });

  it('gives a different set on the next round', () => {
    const first = agentAvatarChoices('worker', 0);
    const second = agentAvatarChoices('worker', 1);
    expect(second.some((choice) => first.includes(choice))).toBe(false);
  });

  it('drops the name avatar from later rounds', () => {
    // Round 0 leads with it; after that the reader has already declined it.
    expect(agentAvatarChoices('worker', 1)).not.toContain(agentAvatarUrlForName('worker'));
  });

  it('gives the same page each time it is asked', () => {
    // A grid that reshuffles on every render is impossible to choose from —
    // the tile you reached for is gone by the time you click.
    expect(agentAvatarChoices('worker', 2)).toEqual(agentAvatarChoices('worker', 2));
  });

  it('gives different agents different choices', () => {
    const worker = agentAvatarChoices('worker', 0);
    const manager = agentAvatarChoices('manager', 0);
    expect(worker.some((choice) => manager.includes(choice))).toBe(false);
  });
});

describe('isThirdPartyAvatarUrl', () => {
  it('matches a DiceBear URL', () => {
    expect(isThirdPartyAvatarUrl(agentAvatarUrlForName('worker'))).toBe(true);
  });

  it('matches a ui-avatars.com URL', () => {
    expect(isThirdPartyAvatarUrl('https://ui-avatars.com/api/?name=Ada+Lovelace')).toBe(true);
  });

  it('matches a subdomain of either host', () => {
    expect(isThirdPartyAvatarUrl('https://api.dicebear.com/10.x/gaze/png?seed=x')).toBe(true);
    expect(isThirdPartyAvatarUrl('https://cdn.ui-avatars.com/api/?name=x')).toBe(true);
  });

  it('matches regardless of case', () => {
    expect(isThirdPartyAvatarUrl('https://API.DICEBEAR.COM/10.x/gaze/png?seed=x')).toBe(true);
  });

  it('ignores a trailing dot on the hostname, as the server does', () => {
    // `dicebear.com.` names the same host as `dicebear.com`.
    expect(isThirdPartyAvatarUrl('https://dicebear.com./10.x/gaze/png?seed=x')).toBe(true);
    expect(isThirdPartyAvatarUrl('https://api.dicebear.com./10.x/gaze/png?seed=x')).toBe(true);
    expect(isThirdPartyAvatarUrl('https://ui-avatars.com./api/?name=x')).toBe(true);
  });

  it('rejects a lookalike host that merely starts or ends with the name', () => {
    // `api.dicebear.com` is a label under `.example`, not a DiceBear subdomain.
    expect(isThirdPartyAvatarUrl('https://api.dicebear.com.example/x')).toBe(false);
    expect(isThirdPartyAvatarUrl('https://notdicebear.com/x.png')).toBe(false);
    expect(isThirdPartyAvatarUrl('https://ui-avatars.com.evil.test/api/?name=x')).toBe(false);
  });

  it('rejects an unrelated host', () => {
    expect(isThirdPartyAvatarUrl('https://example.com/avatar.png')).toBe(false);
  });

  it('answers false for a URL that cannot be parsed', () => {
    expect(isThirdPartyAvatarUrl('not a url')).toBe(false);
  });
});

describe('resolveAgentAvatarSrc', () => {
  // These are AgentAvatar's own states — pulled out so the privacy-sensitive
  // decision ("may a name-seeded or stored third-party URL be shown at all")
  // is tested without rendering the component.

  it('falls back to the name-generated avatar when the server allows it and nothing was chosen', () => {
    expect(resolveAgentAvatarSrc(null, 'worker', true)).toBe(agentAvatarUrlForName('worker'));
  });

  it('shows a chosen icon as-is when the server allows third-party avatars', () => {
    expect(resolveAgentAvatarSrc('https://example.com/a.png', 'worker', true)).toBe(
      'https://example.com/a.png'
    );
  });

  it('shows nothing — not the name-generated avatar — when the server disables them', () => {
    expect(resolveAgentAvatarSrc(null, 'worker', false)).toBeNull();
  });

  it('withholds a stored third-party icon when the server disables them', () => {
    expect(resolveAgentAvatarSrc(agentAvatarUrlForName('worker'), 'worker', false)).toBeNull();
  });

  it('still shows a custom, non-third-party icon when the server disables third-party avatars', () => {
    expect(resolveAgentAvatarSrc('https://example.com/a.png', 'worker', false)).toBe(
      'https://example.com/a.png'
    );
  });

  it('treats "not known yet" exactly like disabled, not like enabled', () => {
    expect(resolveAgentAvatarSrc(null, 'worker', null)).toBeNull();
    expect(resolveAgentAvatarSrc(agentAvatarUrlForName('worker'), 'worker', null)).toBeNull();
  });

  it('still shows a custom, non-third-party icon while the server is not known yet', () => {
    expect(resolveAgentAvatarSrc('https://example.com/a.png', 'worker', null)).toBe(
      'https://example.com/a.png'
    );
  });
});

describe('agentInitials', () => {
  it('takes the first letter of a single-word name', () => {
    expect(agentInitials('worker')).toBe('W');
  });

  it('treats underscores as word breaks', () => {
    expect(agentInitials('switch_worker')).toBe('SW');
  });

  it('treats hyphens and spaces as word breaks too', () => {
    expect(agentInitials('obsidian-backup')).toBe('OB');
    expect(agentInitials('code review bot')).toBe('CR');
  });

  it('stops at two letters', () => {
    expect(agentInitials('one_two_three_four')).toBe('OT');
  });

  it('answers for a name that is empty or only separators', () => {
    // Reached while a new agent is being named, so it must not render blank.
    expect(agentInitials('')).toBe('?');
    expect(agentInitials('___')).toBe('?');
  });
});
