import { describe, expect, it } from 'vitest';
import { summarizeTemplate, type TemplateSummary } from './template-summary';

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

describe('summarizeTemplate on a version 2 document', () => {
  const expert = `
version: 2
params:
  start_in: { type: enum, enum: [nowhere, new_room], default: nowhere }
  existing_room: { type: room, if: "{start_in} == existing_room" }
  topic: { type: string }
  machine: { type: machine, default: [$first] }
resources:
  expert:
    type: agent
    display_name: Switch expert
    description: Knows Switch
  expert_room:
    type: room
    if: "{start_in} == new_room"
    name: Ask the expert
`;

  it('counts what every run creates and asks, not what only some answers do', () => {
    expect(counts(summarizeTemplate(expert))).toEqual({
      kind: 'agent',
      rooms: 0,
      agents: 1,
      inputs: 1,
    });
  });

  it('lists the conditional room, saying it is created only for some answers', () => {
    const s = summarizeTemplate(expert);
    expect(s.creates.map((c) => [c.kind, c.name])).toEqual([
      ['room', 'Ask the expert'],
      ['agent', 'Switch expert'],
    ]);
    expect(s.creates[0].description).toBe('A room. Created only for some answers.');
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
    expect(s.creates.map((c) => [c.kind, c.name])).toEqual([
      ['room', '{team}-triage'],
      ['agent', '{team}-triager'],
      ['agent', '{team}-repro'],
    ]);
    expect(s.creates[0].description).toBe('With {team}-triager, {team}-repro');
    expect(s.creates[1].description).toBe('Reads reports');
  });
});
