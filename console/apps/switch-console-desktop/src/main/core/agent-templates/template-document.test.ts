import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  composeTemplateDocument,
  formOptions,
  serverDocument,
  parseAgentTemplate,
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

describe('serverDocument', () => {
  it('keeps the server half and drops agents and provider params', () => {
    const doc = load(serverDocument(TRIAGE_PAIR) ?? '') as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['kickoff', 'params', 'room', 'version']);
    expect(Object.keys(doc.params as object)).toEqual(['team', 'bridge']);
    expect((doc.room as { agents: string[] }).agents).toEqual(['{team}-triager', '{team}-repro']);
  });

  it('keeps provider params when asked, for the form', () => {
    const doc = load(serverDocument(TRIAGE_PAIR, { keepConsoleParams: true }) ?? '') as {
      params: Record<string, unknown>;
    };
    expect(Object.keys(doc.params)).toEqual(['team', 'provider', 'bridge']);
  });

  it('drops params only an agent entry reads, and every Console type', () => {
    const doc = load(
      serverDocument(
        [
          'params:',
          '  name:',
          '    type: string',
          '    default: Expert',
          '  where:',
          '    type: room',
          '    default: [$new]',
          '  location:',
          '    type: location',
          '    default: local',
          '  bridge:',
          '    type: bridge',
          '    default: [$first]',
          'agent:',
          '  display_name: "{name}"',
          '  location: "{location}"',
          '  join: ["{where}"]',
          'room:',
          '  name: "Ask {agent}"',
          '  bridge: "{bridge}"',
        ].join('\n')
      ) ?? ''
    ) as { params: Record<string, unknown> };
    expect(Object.keys(doc.params)).toEqual(['agent', 'bridge']);
    expect(doc.params.bridge).toEqual({ type: 'bridge', default: ['$first'] });
  });

  it('declares {agent} for a lone agent', () => {
    const doc = load(serverDocument(SOLO) ?? '') as { params: Record<string, unknown> };
    expect(Object.keys(doc.params)).toEqual(['agent']);
  });

  it('keeps a group document whole', () => {
    const text =
      'group:\n  name: g\nrooms:\n  - name: a\n    kickoff: hi\nlinks: []\nagents:\n  - name: x\n    instructions: i\n';
    const doc = load(serverDocument(text) ?? '') as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['group', 'links', 'rooms']);
  });

  it('keeps a misplaced group kickoff for the server to refuse', () => {
    const doc = load(
      serverDocument('group:\n  name: g\nrooms:\n  - name: a\nkickoff: hi\n') ?? ''
    ) as Record<string, unknown>;
    expect(doc.kickoff).toBe('hi');
  });

  it('is null without a room half', () => {
    expect(serverDocument('agent:\n  name: a\n  instructions: i\n')).toBeNull();
  });
});

describe('substituteAgentSlots', () => {
  it('renames agents in every room, aliases included', () => {
    const core = serverDocument(TRIAGE_PAIR) ?? '';
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

describe('composeTemplateDocument', () => {
  it('fills every agent missing instructions', () => {
    const out = load(
      composeTemplateDocument('agents:\n  - name: a\n  - name: b\n    instructions: own\n', 'P')
    ) as { agents: { instructions: string }[] };
    expect(out.agents.map((a) => a.instructions)).toEqual(['P', 'own']);
  });
});

describe('substituteAgentSlots: whole names', () => {
  it('leaves a longer name alone when a shorter one that starts it is renamed', () => {
    const core =
      'room:\n  name: r\n  agents: [helper, helper-bot]\nkickoff: "@helper-bot please brief @helper."\n';
    const out = load(substituteAgentSlots(core, { helper: 'bob' })) as {
      room: { agents: string[] };
      kickoff: string;
    };
    expect(out.room.agents).toEqual(['bob', 'helper-bot']);
    expect(out.kickoff).toBe('@helper-bot please brief @bob.');
  });

  it('renames both when both change, whichever order the map lists them', () => {
    const core = 'room:\n  name: r\n  agents: ["{t}-a", "{t}-ab"]\nkickoff: "@{t}-a and @{t}-ab"\n';
    for (const map of [
      { '{t}-a': 'x-a', '{t}-ab': 'x-ab' },
      { '{t}-ab': 'x-ab', '{t}-a': 'x-a' },
    ]) {
      const out = load(substituteAgentSlots(core, map)) as { kickoff: string };
      expect(out.kickoff).toBe('@x-a and @x-ab');
    }
  });

  it('leaves a name that ends in the renamed one alone, and a dotted one too', () => {
    const core =
      'room:\n  name: r\n  agents: [helper]\nkickoff: "@my-helper, @helper._bot and @helper."\n';
    const out = load(substituteAgentSlots(core, { helper: 'bob' })) as { kickoff: string };
    expect(out.kickoff).toBe('@my-helper, @helper._bot and @bob.');
  });

  it('has no single-agent view of a document with several agents', () => {
    expect(() => parseAgentTemplate('agents:\n  - name: a\n    instructions: i\n')).toThrow(
      /several agents/
    );
  });
});

describe('formOptions', () => {
  it('reads the advanced fold settings and falls back to a folded "Advanced"', () => {
    expect(
      formOptions('form:\n  advanced:\n    label: More\n    open: true\nroom:\n  name: r\n')
    ).toEqual({ advanced: { label: 'More', open: true } });
    expect(formOptions('room:\n  name: r\n')).toEqual({
      advanced: { label: 'Advanced', open: false },
    });
  });
});

describe('parseTemplateAgents: what a template leaves unsaid', () => {
  it('reports each runtime setting an agent has no field or shared param for', () => {
    const { unsaid } = parseTemplateAgents(`
agent:
  name: helper
  provider: claude
  instructions: Help.
`);
    expect(unsaid).toEqual([
      { index: 0, label: 'helper', field: 'location' },
      { index: 0, label: 'helper', field: 'directory' },
    ]);
  });

  it('counts a param of that type no field reads as said for every agent', () => {
    const { unsaid } = parseTemplateAgents(`
params:
  provider: { type: provider, default: [claude] }
  where: { type: location, default: local }
  dir: { type: directory, default: "{$agents_dir}/{agent}" }
agents:
  - name: a
    instructions: A.
  - name: b
    instructions: B.
`);
    expect(unsaid).toEqual([]);
  });

  it('does not count a param one agent reads as said for another', () => {
    const { unsaid } = parseTemplateAgents(`
params:
  where: { type: location, default: local }
agents:
  - name: a
    provider: claude
    location: "{where}"
    directory: /tmp/a
    instructions: A.
  - name: b
    provider: claude
    directory: /tmp/b
    instructions: B.
`);
    expect(unsaid).toEqual([{ index: 1, label: 'b', field: 'location' }]);
  });

  it('records every placeholder an entry reads, its instructions included', () => {
    const { agents } = parseTemplateAgents(`
agent:
  name: "{team}-fixer"
  instructions: Work on {repo}.
`);
    expect(agents[0].placeholders.sort()).toEqual(['repo', 'team']);
  });
});

describe('parseTemplateAgents: allow_existing', () => {
  it('lets an entry be filled by an existing agent only when the template says so', () => {
    const { agents } = parseTemplateAgents(`
agents:
  - name: reviewer
    allow_existing: true
    instructions: Review.
  - name: fixer
    instructions: Fix.
`);
    expect(agents.map((a) => a.allowExisting)).toEqual([true, false]);
  });
});
