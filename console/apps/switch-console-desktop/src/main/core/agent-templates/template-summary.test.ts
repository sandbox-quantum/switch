import { describe, expect, it } from 'vitest';
import { describeSummary, summarizeTemplate, type TemplateSummary } from './template-summary';

const counts = ({ creates: _creates, ...rest }: TemplateSummary) => rest;

describe('summarizeTemplate', () => {
  it('counts an agent template with a companion room as one of each', () => {
    const s = summarizeTemplate(`
agent:
  name: switch-expert
room:
  name: "Ask {agent}"
  agents: ["{agent}", helper]
`);
    expect(counts(s)).toEqual({ kind: 'agent', rooms: 1, agents: 1, inputs: 0 });
    expect(describeSummary(s)).toEqual({
      creates: 'Creates 1 room and 1 agent',
      inputs: 'no inputs',
    });
  });

  it('counts an agent template without a room as one agent', () => {
    expect(counts(summarizeTemplate('agent:\n  name: jq-expert\n'))).toEqual({
      kind: 'agent',
      rooms: 0,
      agents: 1,
      inputs: 0,
    });
  });

  it('counts a room template by its rooms and params, not the agents it names', () => {
    const s = summarizeTemplate(`
params:
  red: { type: agent }
  blue: { type: agent }
  topic: { type: string }
room:
  name: "{topic}"
  agents: ["{red}", "{blue}", judge]
`);
    expect(counts(s)).toEqual({ kind: 'room', rooms: 1, agents: 0, inputs: 3 });
    expect(describeSummary(s).creates).toBe('Creates 1 room');
    expect(describeSummary(s).inputs).toBe('3 inputs');
  });

  it('counts a rooms-only group by its rooms', () => {
    const s = summarizeTemplate(`
params:
  lead: { type: agent }
rooms:
  - name: plan
    agents: ["{lead}", scribe]
  - name: build
    agents: ["{lead}", coder]
`);
    expect(counts(s)).toEqual({ kind: 'group', rooms: 2, agents: 0, inputs: 1 });
  });

  it('does not throw on a document that is not YAML', () => {
    expect(counts(summarizeTemplate('{{{'))).toEqual({
      kind: 'room',
      rooms: 1,
      agents: 0,
      inputs: 0,
    });
  });
});

describe('summarizeTemplate creates', () => {
  it('lists rooms then agents, with the template spelling', () => {
    const s = summarizeTemplate(`
agents:
  - name: "{team}-triager"
    description: Reads reports
  - name: "{team}-repro"
room:
  name: "{team}-triage"
  agents: ["{team}-triager", "{team}-repro"]
`);
    expect(s.kind).toBe('group');
    expect(s.creates.map((c) => [c.kind, c.label])).toEqual([
      ['room', '{team}-triage'],
      ['agent', '{team}-triager'],
      ['agent', '{team}-repro'],
    ]);
    expect(s.creates[0].note).toBe('With {team}-triager, {team}-repro');
    expect(s.creates[1].note).toBe('Reads reports');
  });
});
