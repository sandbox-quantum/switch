import { describe, expect, it } from 'vitest';
import {
  buildManagedDefinition,
  type DefinitionSource,
  definitionBody,
  MAX_INSTRUCTIONS_BYTES,
} from './managed-definition';

const SOURCE: DefinitionSource = {
  providerId: 'claude',
  specialization: undefined,
  providerDefinition: false,
  autoApprove: true,
  directory: '/work/builder',
  stoppedByHand: false,
  shellSetup: false,
  chosenBinary: null,
  subagentDefinition: null,
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

  it('names the effort, and OpenCode’s variant, which it cannot carry', () => {
    expect(
      buildManagedDefinition({ ...SOURCE, specialization: { model: 'o3', effort: 'high' } })
        .notCarried
    ).toEqual([expect.stringContaining('reasoning effort “high”')]);
    expect(
      buildManagedDefinition({
        ...SOURCE,
        providerId: 'opencode',
        specialization: { model: 'anthropic/claude', variant: 'max' },
      }).notCarried
    ).toEqual([expect.stringContaining('model variant “max”')]);
  });

  it('lists the other launch settings, the provider definition, shell setup and a chosen CLI', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      providerId: 'codex',
      specialization: { sandbox: 'workspace-write', approval: 'never', empty: '' },
      providerDefinition: true,
      shellSetup: true,
      chosenBinary: '/opt/codex/bin/codex',
    });
    expect(built.notCarried).toEqual([
      'Launch settings with no managed equivalent: approval, sandbox (Codex launch profile).',
      expect.stringContaining('provider agent definition'),
      expect.stringContaining('shell setup'),
      expect.stringContaining('/opt/codex/bin/codex'),
    ]);
  });

  it('gives a subagent its definition’s prompt after its parent’s instructions', () => {
    const built = buildManagedDefinition({
      ...SOURCE,
      specialization: { instructions: 'Parent instructions.' },
      providerDefinition: true,
      subagentDefinition: { name: 'reviewer', body: 'You review code.' },
    });
    expect(built.definition.instructions).toBe('Parent instructions.\n\nYou review code.');
    expect(built.notCarried).toEqual([expect.stringContaining('reviewer’s definition file')]);
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

describe('a definition file’s body', () => {
  it('is what follows the front matter', () => {
    expect(definitionBody('---\nname: reviewer\ntools: Read\n---\n\nYou review code.\n')).toBe(
      'You review code.'
    );
    expect(definitionBody('No front matter.')).toBe('No front matter.');
  });
});
