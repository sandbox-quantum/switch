import { describe, expect, it } from 'vitest';
import { emptyObservation } from './runtime';
import type { AgentAssignment } from './schemas';
import { mapAgentProcess } from './status';
import type { AgentRow } from './store';

const NOW = Date.parse('2026-10-27T13:00:00Z');
const DETAIL = 'Stopped by the memory guard at 3.9 GiB (its limit is 3.6 GiB).';

function entry(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision: 2,
    desired_state: 'running',
    definition: {
      name: 'scout',
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      auto_mode: false,
      directory: null,
      isolation: 'isolated',
    },
    ...overrides,
  };
}

const row: AgentRow = {
  agentId: 'agent-1',
  appliedRevision: 2,
  changedAt: '2026-10-27T12:00:00Z',
  failure: null,
};

function map(
  guardStop: string | null,
  overrides: { assignment?: AgentAssignment; row?: AgentRow } = {}
) {
  return mapAgentProcess({
    assignment: overrides.assignment ?? entry(),
    row: overrides.row ?? row,
    observation: emptyObservation(),
    relayAttached: false,
    nowMs: NOW,
    guardStop,
  });
}

describe('an agent the memory guard stopped', () => {
  it('reads stopped for out_of_memory, with the detail, while desired stays running', () => {
    expect(map(DETAIL)).toEqual({
      process: 'stopped',
      attached: false,
      reason: 'out_of_memory',
      detail: DETAIL,
    });
  });

  it('reads as before without a guard stop: a host gone with no failure is a crash', () => {
    expect(map(null)).toMatchObject({ process: 'crashed', reason: 'internal' });
  });

  it("gives way to the owner's stop and to a failure", () => {
    expect(map(DETAIL, { assignment: entry({ desired_state: 'stopped' }) })).toEqual({
      process: 'stopped',
      attached: false,
    });
    expect(
      map(DETAIL, {
        row: {
          ...row,
          failure: { revision: 2, reason: 'internal', detail: 'gave up' },
        } as AgentRow,
      })
    ).toMatchObject({ process: 'failed', reason: 'internal' });
  });
});
