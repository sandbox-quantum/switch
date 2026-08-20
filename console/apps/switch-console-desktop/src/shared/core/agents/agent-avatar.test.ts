import { describe, expect, it } from 'vitest';
import {
  AVATAR_CHOICE_COUNT,
  agentAvatarChoices,
  agentAvatarUrlForName,
  agentAvatarUrlForSeed,
  agentInitials,
  randomAgentAvatarUrl,
} from './agent-avatar';

describe('randomAgentAvatarUrl', () => {
  it('draws a different bot each time', () => {
    // A new agent opens on one of these, so two agents created in a row must
    // not look alike.
    const urls = new Set(Array.from({ length: 20 }, randomAgentAvatarUrl));
    expect(urls.size).toBe(20);
  });

  it('is an ordinary avatar URL once drawn', () => {
    expect(randomAgentAvatarUrl()).toContain('/bottts/png?');
  });
});

describe('agentAvatarUrlForSeed', () => {
  it('is stable for a seed', () => {
    // The whole scheme rests on this: an agent's generated avatar is stored
    // nowhere, so the same seed has to redraw the same bot forever.
    expect(agentAvatarUrlForSeed('worker')).toBe(agentAvatarUrlForSeed('worker'));
  });

  it('differs between seeds', () => {
    expect(agentAvatarUrlForSeed('worker')).not.toBe(agentAvatarUrlForSeed('manager'));
  });

  it('asks for a raster image, not a vector one', () => {
    // Slack, Discord and Mattermost are handed this exact URL as the agent's
    // avatar and none of them render SVG. An `svg` here would look right in
    // the app and show nothing on any chat platform.
    expect(agentAvatarUrlForSeed('worker')).toContain('/bottts/png?');
    expect(agentAvatarUrlForSeed('worker')).not.toContain('/svg');
  });

  it('pins the drawing version', () => {
    // Unpinned, every stored icon silently becomes a different bot the day the
    // service ships a new major.
    expect(agentAvatarUrlForSeed('worker')).toContain('/9.x/');
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

describe('agentInitials', () => {
  it('takes the first letter of a single-word name', () => {
    expect(agentInitials('worker')).toBe('W');
  });

  it('treats underscores as word breaks', () => {
    // Matches what the Switch bridges put on Slack for the same agent, so the
    // offline fallback here and the platform fallback there agree.
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
