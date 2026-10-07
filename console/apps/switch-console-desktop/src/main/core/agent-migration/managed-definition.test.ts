import { describe, expect, it } from 'vitest';
import {
  buildManagedDefinition,
  type DefinitionSource,
  MAX_INSTRUCTIONS_BYTES,
} from './managed-definition';

const SOURCE: DefinitionSource = {
  providerId: 'claude',
  name: 'builder',
  specialization: undefined,
  providerDefinition: undefined,
  autoApprove: true,
  directory: '/work/builder',
  stoppedByHand: false,
  shellSetup: false,
  chosenBinary: null,
};

describe('the managed definition of a Console agent', () => {
  it('carries the provider, model, instructions, auto-approve and directory', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      specialization: { model: 'sonnet', instructions: 'Review pull requests.' },
    });
    expect(built).toEqual({
      definition: {
        provider: 'claude',
        model: 'sonnet',
        advanced_config: {},
        instructions: 'Review pull requests.',
        auto_approve: true,
        directory: '/work/builder',
      },
      desiredState: 'running',
      notCarried: [],
    });
  });

  it('moves an agent stopped by hand as stopped', () => {
    const built = buildManagedDefinition({ ...SOURCE, stoppedByHand: true });
    expect(built.desiredState).toBe('stopped');
  });

  it('carries the advanced configuration, each value as its field takes it', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      specialization: {
        model: 'opus',
        effort: 'high',
        tools: 'Read, Grep',
        maxTurns: '8',
        background: 'true',
        permissionMode: 'plan',
      },
    });
    expect(built.definition.advanced_config).toEqual({
      effort: 'high',
      tools: ['Read', 'Grep'],
      maxTurns: 8,
      background: true,
      permissionMode: 'plan',
    });
    expect(built.notCarried).toEqual([]);
    expect(
      buildManagedDefinition({
        ...SOURCE,
        providerId: 'opencode',
        specialization: { model: 'anthropic/claude', variant: 'max', temperature: '0.2' },
      }).definition.advanced_config
    ).toEqual({ variant: 'max', temperature: 0.2 });
  });

  it('names a setting whose value its field does not take', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      providerId: 'codex',
      specialization: { effort: 'extreme', verbosity: 'low' },
    });
    expect(built.definition.advanced_config).toEqual({ verbosity: 'low' });
    expect(built.notCarried).toEqual([expect.stringContaining('Reasoning effort (“extreme”)')]);
  });

  it('lists the other launch settings, shell setup and a chosen CLI', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      providerId: 'codex',
      specialization: { sandbox: 'workspace-write', approval: 'never', empty: '' },
      shellSetup: true,
      chosenBinary: '/opt/codex/bin/codex',
    });
    expect(built.notCarried).toEqual([
      'Launch settings with no managed equivalent: approval, sandbox (Codex launch profile).',
      expect.stringContaining('shell setup'),
      expect.stringContaining('/opt/codex/bin/codex'),
    ]);
  });

  it('says nothing of a provider definition the managed agent runs as it is', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      specialization: { model: 'opus', tools: 'Read', instructions: 'Build.' },
      providerDefinition: {
        description: 'builder',
        prompt: 'Build.',
        model: 'opus',
        tools: ['Read', 'mcp__switch'],
      },
    });
    expect(built.notCarried).toEqual([]);
  });

  it('names what of the provider definition the managed agent’s differs in', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      specialization: { instructions: 'Build.' },
      providerDefinition: { description: 'Builds the app', prompt: 'Build.' },
    });
    expect(built.notCarried).toEqual([
      expect.stringContaining('provider agent definition this agent launches as (description)'),
    ]);
  });

  it('refuses instructions longer than Switch takes', () => {
    expect(() =>
      buildManagedDefinition({
        ...SOURCE,
        specialization: { instructions: 'x'.repeat(MAX_INSTRUCTIONS_BYTES + 1) },
      })
    ).toThrow(/KiB/);
  });
});
