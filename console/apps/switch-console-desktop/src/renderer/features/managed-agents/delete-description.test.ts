import { describe, expect, it } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { deleteDescription } from './delete-description';

const BASE = 'Its machine stops it and it is deleted from Switch, for every room it is in.';

const agent = (
  agentId: string,
  provider: string,
  kind = 'ec2',
  displayName: string | null = null
): ManagedAgentView =>
  ({
    agentId,
    name: agentId,
    displayName,
    machine: { id: 'c-box', name: 'Your cloud', kind, state: 'online' },
    definition: { provider },
  }) as unknown as ManagedAgentView;

describe('deleteDescription', () => {
  it("says the login goes too for the provider's last agent on the box", () => {
    const a = agent('a', 'claude');
    expect(deleteDescription(a, [a, agent('b', 'codex')], true)).toBe(
      `${BASE} Its Claude Code login is taken off your cloud too, as no other agent there uses it.`
    );
  });

  it('names the agents that keep a shared login', () => {
    const a = agent('a', 'claude');
    const agents = [
      a,
      agent('b', 'claude', 'ec2', 'Researcher'),
      agent('c', 'claude', 'ec2', 'Copy writer'),
    ];
    expect(deleteDescription(a, agents, true)).toBe(
      `${BASE} The Claude Code login stays on your cloud, because Copy writer, Researcher still use it.`
    );
  });

  it('is as before with hosted agents v2 off, or for an agent not on a cloud box', () => {
    const a = agent('a', 'claude');
    expect(deleteDescription(a, [a], false)).toBe(BASE);
    const mac = agent('m', 'claude', 'console');
    expect(deleteDescription(mac, [mac], true)).toBe(BASE);
  });
});
