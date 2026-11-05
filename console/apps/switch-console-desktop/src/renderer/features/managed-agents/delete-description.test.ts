import { describe, expect, it } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { confirmedWithdraw, deleteDescription } from './delete-description';

const BASE = 'Its machine stops it and it is deleted from Switch, for every room it is in.';

const agent = (
  agentId: string,
  provider: string,
  controllerId = 'c-box',
  displayName: string | null = null
): ManagedAgentView =>
  ({
    agentId,
    name: agentId,
    displayName,
    // Every machine says `ec2` here: the kind must never decide anything.
    machine: { id: controllerId, name: 'Your cloud', kind: 'ec2', state: 'online' },
    definition: { provider },
  }) as unknown as ManagedAgentView;

describe('deleteDescription', () => {
  it("says the login goes too for the provider's last agent on the box", () => {
    const a = agent('a', 'claude');
    expect(deleteDescription(a, [a, agent('b', 'codex')], 'c-box')).toBe(
      `${BASE} Its Claude Code login is taken off your cloud too, as no other agent there uses it.`
    );
  });

  it('names the agents that keep a shared login', () => {
    const a = agent('a', 'claude');
    const agents = [
      a,
      agent('b', 'claude', 'c-box', 'Researcher'),
      agent('c', 'claude', 'c-box', 'Copy writer'),
    ];
    expect(deleteDescription(a, agents, 'c-box')).toBe(
      `${BASE} The Claude Code login stays on your cloud, because Copy writer, Researcher still use it.`
    );
  });

  it('is as before with no v2 box, or for an agent not on it, whatever its machine kind', () => {
    const a = agent('a', 'claude');
    expect(deleteDescription(a, [a], null)).toBe(BASE);
    const mac = agent('m', 'claude', 'c-mac');
    expect(deleteDescription(mac, [mac], 'c-box')).toBe(BASE);
  });

  it('passes what the confirm said about the login with the delete', () => {
    const a = agent('a', 'claude');
    expect(confirmedWithdraw(a, [a], 'c-box')).toBe(true);
    expect(confirmedWithdraw(a, [a, agent('b', 'claude')], 'c-box')).toBe(false);
    expect(confirmedWithdraw(a, [a], null)).toBeUndefined();
  });
});
