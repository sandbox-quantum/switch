import { describe, expect, it } from 'vitest';
import type { ChatAgent } from '@shared/core/chats/chats';
import type { ManagedAgentView, ManagedMachine } from '@shared/core/managed-agents/managed-agents';
import { AVAILABLE, chatAvailability } from './machine-availability';

const chatAgent = (id: string, name: string): ChatAgent => ({
  id,
  name,
  displayName: null,
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: true,
});

const managed = (agentId: string, machine: ManagedMachine | null) =>
  ({ agentId, machine }) as ManagedAgentView;

const laptop = (state: ManagedMachine['state']): ManagedMachine => ({
  id: 'c1',
  name: 'FHXDK633MX',
  kind: 'console',
  state,
});

const porky = chatAgent('a1', 'porky');
const bugs = chatAgent('a2', 'bugs');

describe('chatAvailability', () => {
  it('blocks a 1:1 chat whose agent machine is offline', () => {
    expect(chatAvailability([porky], 0, [managed('a1', laptop('offline'))])).toEqual({
      block: true,
      bar: "FHXDK633MX is offline. porky can't reply until it's back.",
      offlineAgentIds: ['a1'],
    });
  });

  it('does nothing while the machine is online', () => {
    expect(chatAvailability([porky], 0, [managed('a1', laptop('online'))])).toEqual(AVAILABLE);
  });

  it('does not block when the machine state is unknown or not known at all', () => {
    expect(chatAvailability([porky], 0, [managed('a1', laptop('unknown'))])).toEqual(AVAILABLE);
    expect(chatAvailability([porky], 0, [managed('a1', null)])).toEqual(AVAILABLE);
    expect(chatAvailability([porky], 0, [])).toEqual(AVAILABLE);
    expect(chatAvailability([porky], 0, null)).toEqual(AVAILABLE);
  });

  it('warns but never blocks a group with one offline agent', () => {
    const list = [managed('a1', laptop('offline')), managed('a2', laptop('online'))];
    expect(chatAvailability([porky, bugs], 0, list)).toEqual({
      block: false,
      bar: "porky's machine (FHXDK633MX) is offline.",
      offlineAgentIds: ['a1'],
    });
    expect(chatAvailability([porky], 1, list).block).toBe(false);
  });

  it('shows a sleeping cloud machine as waking up, without blocking', () => {
    const cloud: ManagedMachine = { id: 'c2', name: 'cloud-1', kind: 'ec2', state: 'offline' };
    expect(chatAvailability([porky], 0, [managed('a1', cloud)])).toEqual({
      block: false,
      bar: 'cloud-1 is waking up…',
      offlineAgentIds: [],
    });
  });
});
