import { describe, expect, it } from 'vitest';
import { parseTemplateAgents } from '@main/core/agent-templates/template-document';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  chooseCase,
  permissionsOnCreate,
  runsWithoutAsking,
  whoCanAddress,
} from './agent-permissions';
import { runAgent } from './managed-run';

describe('runsWithoutAsking', () => {
  it('reads a plain auto_approve', () => {
    expect(runsWithoutAsking(true, {})).toBe(true);
    expect(runsWithoutAsking(false, {})).toBe(false);
    expect(runsWithoutAsking(undefined, {})).toBe(false);
  });

  it('reads a {param} from the inputs', () => {
    expect(runsWithoutAsking('{bypass}', { bypass: true })).toBe(true);
    expect(runsWithoutAsking('{bypass}', { bypass: false })).toBe(false);
    expect(runsWithoutAsking('{bypass}', {})).toBe(false);
  });

  it('chooses among version 2 cases as the server does', () => {
    const cases = [{ if: '{mode} == yolo', value: true }, { value: false }];
    expect(runsWithoutAsking(cases, { mode: 'yolo' })).toBe(true);
    expect(runsWithoutAsking(cases, { mode: 'careful' })).toBe(false);
  });

  it('cannot tell a value it does not read, rather than calling it safe', () => {
    expect(runsWithoutAsking('yes', {})).toBeNull();
    expect(runsWithoutAsking({ always: true }, {})).toBeNull();
    expect(runsWithoutAsking('{mode}', { mode: 'sure' })).toBeNull();
  });
});

describe('whoCanAddress', () => {
  it('defaults to the owner and their agents', () => {
    expect(whoCanAddress(undefined, {})).toEqual({ kind: 'owner-agents' });
  });

  it('reads each plain addressing', () => {
    expect(whoCanAddress('owner', {})).toEqual({ kind: 'owner' });
    expect(whoCanAddress('owner-agents', {})).toEqual({ kind: 'owner-agents' });
    expect(whoCanAddress('anyone', {})).toEqual({ kind: 'anyone' });
  });

  it('reads the rooms an anyone_in names', () => {
    expect(whoCanAddress({ anyone_in: ['sprint_room'] }, {})).toEqual({
      kind: 'rooms',
      rooms: ['sprint_room'],
    });
  });

  it('chooses among version 2 cases, as the Switch expert template writes them', () => {
    const cases = [
      { if: '{start_in} == new_room', value: { anyone_in: ['expert_room'] } },
      { value: 'anyone' },
    ];
    expect(whoCanAddress(cases, { start_in: 'new_room' })).toEqual({
      kind: 'rooms',
      rooms: ['expert_room'],
    });
    expect(whoCanAddress(cases, { start_in: 'existing_room' })).toEqual({ kind: 'anyone' });
  });

  it('cannot tell a form it does not read', () => {
    expect(whoCanAddress('everyone', {})).toEqual({ kind: 'unknown' });
    expect(whoCanAddress({ anyone_in: 'room' }, {})).toEqual({ kind: 'unknown' });
  });
});

describe('chooseCase', () => {
  it('leaves a field without cases as it is', () => {
    expect(chooseCase(['a', 'b'], {})).toEqual(['a', 'b']);
    expect(chooseCase('anyone', {})).toBe('anyone');
  });

  it('chooses nothing when no case holds', () => {
    expect(chooseCase([{ if: '{x}', value: true }], { x: false })).toBeUndefined();
  });
});

describe('permissionsOnCreate', () => {
  const MACHINE: OwnedMachine = {
    id: 'm1',
    name: 'laptop',
    kind: 'console',
    state: 'online',
    providers: [{ provider: 'claude', ready: true, problem: null, detail: null, loginHelps: true }],
    acceptsLogins: true,
    cloud: false,
    workspacesDir: '/home/me/.switch/agents',
    os: 'linux',
    local: { kind: 'this-computer' },
  };
  // Version 2's cases, as the Switch expert template writes them.
  const CASES = [
    'auto_approve:',
    '  - if: "{mode} == yolo"',
    '    value: true',
    '  - value: false',
    'addressing:',
    '  - if: "{mode} == yolo"',
    '    value: anyone',
    '  - value: owner',
  ];
  const indented = (lines: string[], by: number) => lines.map((line) => ' '.repeat(by) + line);
  /** A version 1 template's one agent, with `fields` added to it. */
  const v1 = (fields: string[]) =>
    parseTemplateAgents(
      ['agent:', '  name: helper', '  instructions: Help.', ...indented(fields, 2)].join('\n')
    ).agents[0]!;
  /** A version 2 document's one agent, with `fields` added to it. */
  const v2 = (fields: string[]) =>
    parseTemplateAgents(
      [
        'version: 2',
        'resources:',
        '  helper:',
        '    type: agent',
        '    instructions: Help.',
        ...indented(fields, 4),
      ].join('\n')
    ).agents[0]!;
  /** What a managed run sends the server for the entry: what is actually created. */
  const sent = (entry: ReturnType<typeof v1>, values: Record<string, string | boolean>) =>
    runAgent({
      slot: 'helper',
      name: 'helper',
      entry,
      values,
      displayName: null,
      provider: 'claude',
      machine: MACHINE,
      directoryText: '',
    });

  it('reads a version 1 template’s cases as its run does: not at all', () => {
    const entry = v1(CASES);
    const values = { mode: 'yolo' };
    const managed = permissionsOnCreate(entry, values, 'managed');
    expect(managed).toEqual({ bypass: false, reach: { kind: 'owner-agents' } });
    expect(managed.bypass).toBe(sent(entry, values).autoApprove);
    expect(managed.reach).toEqual({ kind: sent(entry, values).addressing });
    expect(permissionsOnCreate(entry, values, 'console')).toEqual({
      bypass: false,
      reach: { kind: 'owner-agents' },
    });
  });

  it('chooses among a version 2 document’s cases, as the server does', () => {
    const entry = v2(CASES);
    expect(permissionsOnCreate(entry, { mode: 'yolo' }, 'document')).toEqual({
      bypass: true,
      reach: { kind: 'anyone' },
    });
    expect(permissionsOnCreate(entry, { mode: 'careful' }, 'document')).toEqual({
      bypass: false,
      reach: { kind: 'owner' },
    });
  });

  it('matches what a managed run sends for plain fields and params', () => {
    const entry = v1(['auto_approve: "{yolo}"', 'addressing: anyone']);
    for (const yolo of [true, false]) {
      const shown = permissionsOnCreate(entry, { yolo }, 'managed');
      expect(shown.bypass).toBe(yolo);
      expect(shown.bypass).toBe(sent(entry, { yolo }).autoApprove);
      expect(shown.reach).toEqual({ kind: sent(entry, { yolo }).addressing });
    }
    // An agent this Console runs asks first whatever the template says, and keeps its addressing.
    expect(permissionsOnCreate(entry, { yolo: true }, 'console')).toEqual({
      bypass: false,
      reach: { kind: 'anyone' },
    });
  });
});
