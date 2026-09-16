import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  composeTemplateDocument,
  coreDocumentFor,
  dropUnsetParams,
  parseTemplateAgents,
  substituteAgentSlots,
  templateKind,
} from './template-document';

const TRIAGE_PAIR = `
version: 1
params:
  team:
    type: string
    description: Prefix for every name this creates
  provider:
    type: provider
    default: claude
  bridge:
    type: bridge
agents:
  - name: "{team}-triager"
    description: Reads reports, files and routes them
    instructions: You triage.
    provider: "{provider}"
  - name: "{team}-repro"
    description: Reproduces what the triager routes to it
    instructions: You reproduce.
    repo: https://github.com/sandbox-quantum/switch
room:
  name: "{team}-triage"
  bridge: "{bridge}"
  agents: ["{team}-triager", "{team}-repro"]
  aliases:
    "{team}-triager": triager
kickoff: Start.
`;

const SOLO = `
agent:
  name: jq-expert
  instructions: You know jq.
room:
  name: "Ask {agent}"
  agents: ["{agent}"]
`;

describe('templateKind', () => {
  it('tells the three shapes apart', () => {
    expect(templateKind(TRIAGE_PAIR)).toBe('group');
    expect(templateKind(SOLO)).toBe('agent');
    expect(templateKind('room:\n  name: r\n')).toBe('room');
    expect(templateKind('group:\n  name: g\nrooms:\n  - name: a\n')).toBe('group');
  });
});

describe('parseTemplateAgents', () => {
  it('reads every agent of a list, provider included', () => {
    const { agents, warnings } = parseTemplateAgents(TRIAGE_PAIR);
    expect(warnings).toEqual([]);
    expect(agents.map((a) => a.name)).toEqual(['{team}-triager', '{team}-repro']);
    expect(agents[0].provider).toBe('{provider}');
    expect(agents[1].provider).toBeNull();
    expect(agents[1].repoUrl).toBe('https://github.com/sandbox-quantum/switch');
  });

  it('reads a lone agent and fills its instructions from the fallback', () => {
    const { agents } = parseTemplateAgents('agent:\n  name: x\n', 'Persona.');
    expect(agents).toHaveLength(1);
    expect(agents[0].instructions).toBe('Persona.');
  });

  it('tells a lone agent: from a one-entry list', () => {
    expect(parseTemplateAgents('agent:\n  name: a\n  instructions: i\n').singular).toBe(true);
    expect(parseTemplateAgents('agents:\n  - name: a\n    instructions: i\n').singular).toBe(false);
  });

  it('gives a room template no agents', () => {
    expect(parseTemplateAgents('room:\n  name: r\n').agents).toEqual([]);
  });

  it('refuses a listed agent with nothing to go on', () => {
    expect(() =>
      parseTemplateAgents('agents:\n  - name: a\n    instructions: ok\n  - name: b\n')
    ).toThrow(/agent 2 needs "instructions:"/);
  });
});

describe('coreDocumentFor', () => {
  it('keeps the server half and drops agents and provider params', () => {
    const doc = load(coreDocumentFor(TRIAGE_PAIR) ?? '') as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['kickoff', 'params', 'room', 'version']);
    expect(Object.keys(doc.params as object)).toEqual(['team', 'bridge']);
    expect((doc.room as { agents: string[] }).agents).toEqual(['{team}-triager', '{team}-repro']);
  });

  it('keeps provider params when asked, for the form', () => {
    const doc = load(coreDocumentFor(TRIAGE_PAIR, { keepConsoleParams: true }) ?? '') as {
      params: Record<string, unknown>;
    };
    expect(Object.keys(doc.params)).toEqual(['team', 'provider', 'bridge']);
  });

  it('declares {agent} for a lone agent', () => {
    const doc = load(coreDocumentFor(SOLO) ?? '') as { params: Record<string, unknown> };
    expect(Object.keys(doc.params)).toEqual(['agent']);
  });

  it('keeps a group document whole', () => {
    const text =
      'group:\n  name: g\nrooms:\n  - name: a\n    kickoff: hi\nlinks: []\nagents:\n  - name: x\n    instructions: i\n';
    const doc = load(coreDocumentFor(text) ?? '') as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['group', 'links', 'rooms']);
  });

  it('keeps a misplaced group kickoff for the server to refuse', () => {
    const doc = load(
      coreDocumentFor('group:\n  name: g\nrooms:\n  - name: a\nkickoff: hi\n') ?? ''
    ) as Record<string, unknown>;
    expect(doc.kickoff).toBe('hi');
  });

  it('is null without a room half', () => {
    expect(coreDocumentFor('agent:\n  name: a\n  instructions: i\n')).toBeNull();
  });
});

describe('substituteAgentSlots', () => {
  it('renames agents in every room, aliases included', () => {
    const core = coreDocumentFor(TRIAGE_PAIR) ?? '';
    const out = load(substituteAgentSlots(core, { '{team}-triager': 'claude-code.alice' })) as {
      room: { agents: string[]; aliases: Record<string, string> };
    };
    expect(out.room.agents).toEqual(['claude-code.alice', '{team}-repro']);
    expect(out.room.aliases).toEqual({ 'claude-code.alice': 'triager' });
  });
});

describe('substituteAgentSlots kickoffs', () => {
  it('renames the mentions in a kickoff too', () => {
    const core =
      'room:\n  name: r\n  agents: ["{team}-a"]\n  kickoff: "@{team}-a go"\nkickoff: "@{team}-a hi"\n';
    const out = load(substituteAgentSlots(core, { '{team}-a': 'alpha-a-2' })) as {
      room: { kickoff: string };
      kickoff: string;
    };
    expect(out.kickoff).toBe('@alpha-a-2 hi');
    expect(out.room.kickoff).toBe('@alpha-a-2 go');
  });
});

describe('dropUnsetParams', () => {
  it('removes the declaration and the room fields that read it', () => {
    const out = load(
      dropUnsetParams(
        'params:\n  bridge:\n    type: bridge\n  team:\n    type: string\nroom:\n  name: "{team}"\n  bridge: "{bridge}"\n',
        ['bridge']
      )
    ) as { params: Record<string, unknown>; room: Record<string, unknown> };
    expect(Object.keys(out.params)).toEqual(['team']);
    expect(out.room).toEqual({ name: '{team}' });
  });
});

describe('composeTemplateDocument', () => {
  it('fills every agent missing instructions', () => {
    const out = load(
      composeTemplateDocument('agents:\n  - name: a\n  - name: b\n    instructions: own\n', 'P')
    ) as { agents: { instructions: string }[] };
    expect(out.agents.map((a) => a.instructions)).toEqual(['P', 'own']);
  });
});
