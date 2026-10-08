import { describe, expect, it } from 'vitest';
import type {
  AdvancedConfigField,
  ManagedAgentView,
  OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';
import {
  advancedConfigFromForm,
  draftOf,
  editIsEmpty,
  editOf,
  MODEL_FIELD,
  shownDirectory,
} from './managed-agent-changes';

const SCHEMA: AdvancedConfigField[] = [
  {
    key: 'effort',
    label: 'Effort',
    type: 'select',
    options: [
      { value: '', label: 'Inherit' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' },
    ],
  },
  { key: 'tools', label: 'Tools', type: 'list' },
  { key: 'maxTurns', label: 'Max turns', type: 'number' },
  { key: 'background', label: 'Always run in background', type: 'boolean' },
];

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: 'Writes PRDs',
  machine: { id: 'controller-1', name: 'laptop', kind: 'console', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: 'opus',
    advancedConfig: { effort: 'high', tools: ['Read'] },
    instructions: 'Be brief.',
    autoApprove: false,
    directory: '/work/pm',
    isolation: 'shared',
  },
  status: null,
};

describe('editOf', () => {
  it('sends nothing when nothing changed', () => {
    const before = draftOf(AGENT, SCHEMA, null);
    expect(editIsEmpty(editOf(AGENT, SCHEMA, before, before))).toBe(true);
  });

  it('sends only the definition fields that changed', () => {
    const before = draftOf(AGENT, SCHEMA, null);
    const after = {
      ...before,
      autoApprove: true,
      ownProcess: true,
      form: { ...before.form, [MODEL_FIELD.key]: ' sonnet ' },
    };
    expect(editOf(AGENT, SCHEMA, before, after)).toEqual({
      changes: { definition: { autoApprove: true, isolation: 'isolated', model: 'sonnet' } },
    });
  });

  it('replaces the whole advanced configuration when one of its fields changed', () => {
    const before = draftOf(AGENT, SCHEMA, null);
    const after = { ...before, form: { ...before.form, effort: 'max', maxTurns: '12' } };
    expect(editOf(AGENT, SCHEMA, before, after).changes.definition).toEqual({
      advancedConfig: { effort: 'max', tools: ['Read'], maxTurns: 12 },
    });
  });

  it('leaves a cleared field out rather than sending it empty', () => {
    const before = draftOf(AGENT, SCHEMA, null);
    const after = { ...before, form: { ...before.form, effort: '', tools: '' } };
    expect(editOf(AGENT, SCHEMA, before, after).changes.definition).toEqual({
      advancedConfig: {},
    });
  });

  it('keeps a key the schema does not name, for the server to judge', () => {
    const agent = {
      ...AGENT,
      definition: { ...AGENT.definition, advancedConfig: { effort: 'high', legacy: 'x' } },
    };
    const before = draftOf(agent, SCHEMA, null);
    const after = { ...before, form: { ...before.form, effort: 'max' } };
    expect(editOf(agent, SCHEMA, before, after).changes.definition.advancedConfig).toEqual({
      legacy: 'x',
      effort: 'max',
    });
  });

  it('clears the model and the directory to leave them to the provider and the machine', () => {
    const before = draftOf(AGENT, SCHEMA, null);
    const after = { ...before, directory: '  ', form: { ...before.form, [MODEL_FIELD.key]: '' } };
    expect(editOf(AGENT, SCHEMA, before, after).changes.definition).toEqual({
      model: null,
      directory: null,
    });
  });

  it('sends the display name, description and icon on their own', () => {
    const before = draftOf(AGENT, SCHEMA, null);
    const after = { ...before, displayName: ' PM ', description: 'Writes specs', iconUrl: 'x.png' };
    expect(editOf(AGENT, SCHEMA, before, after)).toEqual({
      changes: { definition: {} },
      displayName: 'PM',
      description: 'Writes specs',
      iconUrl: 'x.png',
    });
  });
});

describe('shownDirectory', () => {
  const MACHINE: OwnedMachine = {
    ...AGENT.machine!,
    providers: [],
    local: null,
    workspacesDir: '/srv/workspaces/',
  };
  const unset = { ...AGENT, definition: { ...AGENT.definition, directory: null } };
  const reported = {
    ...unset,
    status: {
      process: 'running',
      attached: true,
      reason: null,
      detail: null,
      directory: '/run/pm',
    },
  };

  it('prefers the definition, then where the machine runs it, then where it will', () => {
    expect(shownDirectory(AGENT, MACHINE)).toBe('/work/pm');
    expect(shownDirectory(reported, MACHINE)).toBe('/run/pm');
    expect(shownDirectory(unset, MACHINE)).toBe('/srv/workspaces/pm-agent');
  });

  it('is empty when nothing says where it runs', () => {
    expect(shownDirectory(unset, { ...MACHINE, workspacesDir: null })).toBe('');
    expect(shownDirectory(unset, null)).toBe('');
  });

  it('sends nothing for the directory it shows until it is edited', () => {
    const before = draftOf(unset, SCHEMA, MACHINE);
    expect(editIsEmpty(editOf(unset, SCHEMA, before, before))).toBe(true);
    expect(
      editOf(unset, SCHEMA, before, { ...before, directory: '/work/other' }).changes.definition
    ).toEqual({ directory: '/work/other' });
  });
});

describe('advancedConfigFromForm', () => {
  it('drops unset values of every type', () => {
    expect(
      advancedConfigFromForm(SCHEMA, { effort: '', tools: ' ', maxTurns: '', background: false })
    ).toEqual({});
    expect(
      advancedConfigFromForm(SCHEMA, {
        effort: 'high',
        tools: 'Read, Grep',
        maxTurns: '3',
        background: true,
      })
    ).toEqual({ effort: 'high', tools: ['Read', 'Grep'], maxTurns: 3, background: true });
  });
});
