import { describe, expect, it } from 'vitest';
import { describeSummary, summarizeTemplate } from './template-summary';

describe('summarizeTemplate', () => {
  it('counts an agent template with a companion room as one of each', () => {
    const s = summarizeTemplate(`
agent:
  name: switch-expert
room:
  name: "Ask {agent}"
  agents: ["{agent}", helper]
`);
    expect(s).toEqual({ kind: 'agent', rooms: 1, agents: 1, inputs: 0 });
    expect(describeSummary(s)).toEqual({
      creates: 'Creates 1 room and 1 agent',
      inputs: 'no inputs',
    });
  });

  it('counts an agent template without a room as one agent', () => {
    expect(summarizeTemplate('agent:\n  name: jq-expert\n')).toEqual({
      kind: 'agent',
      rooms: 0,
      agents: 1,
      inputs: 0,
    });
  });

  it('counts a room template by its agents and params', () => {
    const s = summarizeTemplate(`
params:
  red: { type: agent }
  blue: { type: agent }
  topic: { type: string }
room:
  name: "{topic}"
  agents: ["{red}", "{blue}", judge]
`);
    expect(s).toEqual({ kind: 'room', rooms: 1, agents: 3, inputs: 3 });
    expect(describeSummary(s).creates).toBe('Creates 1 room and 3 agents');
    expect(describeSummary(s).inputs).toBe('3 inputs');
  });

  it('counts a group template across its rooms, agents once each', () => {
    const s = summarizeTemplate(`
params:
  lead: { type: agent }
rooms:
  - name: plan
    agents: ["{lead}", scribe]
  - name: build
    agents: ["{lead}", coder]
`);
    expect(s).toEqual({ kind: 'group', rooms: 2, agents: 3, inputs: 1 });
  });

  it('does not throw on a document that is not YAML', () => {
    expect(summarizeTemplate('{{{')).toEqual({
      kind: 'room',
      rooms: 1,
      agents: 0,
      inputs: 0,
    });
  });
});
