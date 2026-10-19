import { describe, expect, it } from 'vitest';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';
import { agentSections, isAgentSection, shownAgentRoom, shownAgentSection } from './agent-sections';

const GRANTS: ServiceGrants = { grants: [], addressing_open: false };

describe("a managed agent's sections", () => {
  it('offers Connections above Agent settings for an agent whose grants are yours', () => {
    expect(agentSections(true, GRANTS)).toEqual(['connections', 'settings']);
  });

  it('offers Connections while the grants load, since the page lists only your agents', () => {
    expect(agentSections(true, undefined)).toEqual(['connections', 'settings']);
  });

  it("hides Connections for an agent you don't own: the server answers its grants with null", () => {
    expect(agentSections(true, null)).toEqual(['settings']);
  });

  it('hides Connections when the server has service connections off', () => {
    expect(agentSections(false, GRANTS)).toEqual(['settings']);
  });

  it('shows the chosen section, or the chat when Connections was chosen and is no longer offered', () => {
    expect(shownAgentSection('connections', agentSections(true, GRANTS))).toBe('connections');
    expect(shownAgentSection('connections', agentSections(true, null))).toBeNull();
    expect(shownAgentSection('settings', agentSections(false, GRANTS))).toBe('settings');
    expect(shownAgentSection(undefined, agentSections(true, GRANTS))).toBeNull();
  });

  it('accepts only the known sections from a link or saved params', () => {
    expect(isAgentSection('connections')).toBe(true);
    expect(isAgentSection('settings')).toBe(true);
    expect(isAgentSection('chats')).toBe(false);
    expect(isAgentSection(undefined)).toBe(false);
  });

  it('shows the chosen room unless a section is chosen or the agent has left it', () => {
    const rooms = [{ roomId: '!a' }];
    expect(shownAgentRoom('!a', null, rooms)).toBe('!a');
    expect(shownAgentRoom('!a', 'settings', rooms)).toBeNull();
    expect(shownAgentRoom('!b', null, rooms)).toBeNull();
    expect(shownAgentRoom('!b', null, undefined)).toBe('!b');
    expect(shownAgentRoom(undefined, null, rooms)).toBeNull();
  });
});
