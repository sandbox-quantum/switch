import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { codexConfigFromForm } from './codex-config-fields';

/** Stands in for the list the codex plugin serves over RPC. */
const FIELDS: RepoAgentField[] = [
  { key: 'model', label: 'Model', type: 'text' },
  { key: 'effort', label: 'Reasoning effort', type: 'select', options: [] },
  { key: 'instructions', label: 'Instructions', type: 'textarea' },
];

describe('codexConfigFromForm', () => {
  it('assembles a config from a filled form', () => {
    expect(
      codexConfigFromForm(FIELDS, {
        model: 'gpt-5.6-terra',
        effort: 'high',
        instructions: 'Be careful.',
      })
    ).toEqual({
      version: '1',
      model: 'gpt-5.6-terra',
      effort: 'high',
      instructions: 'Be careful.',
    });
  });

  it('drops blank and whitespace-only fields so the base Codex default stands', () => {
    expect(
      codexConfigFromForm(FIELDS, { model: '  gpt-5.6-terra ', effort: '', instructions: '   ' })
    ).toEqual({
      version: '1',
      model: 'gpt-5.6-terra',
      effort: undefined,
      instructions: undefined,
    });
  });

  it('is null when nothing is set — no profile, and no --profile argv', () => {
    expect(codexConfigFromForm(FIELDS, { model: '', effort: '', instructions: '' })).toBeNull();
    expect(codexConfigFromForm(FIELDS, { model: '  ', effort: '', instructions: '\n' })).toBeNull();
  });
});
