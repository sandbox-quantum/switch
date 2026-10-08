import { describe, expect, it } from 'vitest';
import { choicesNotOffered, localAdvancedFields } from './local-advanced-fields';

const CODEX = { id: 'codex', label: 'Codex' };
const EFFORT = {
  key: 'effort',
  label: 'Reasoning effort',
  type: 'select' as const,
  options: [
    { value: '', label: 'Default' },
    { value: 'high', label: 'high' },
  ],
};

describe('localAdvancedFields', () => {
  it('offers the model, then the server’s fields the plugin applies', () => {
    expect(
      localAdvancedFields(
        CODEX,
        { surface: 'launch-profile', keys: ['effort'] },
        { kind: 'schema', schema: { codex: [EFFORT] } }
      )
    ).toEqual({ fields: [{ key: 'model', label: 'Model', type: 'text' }, EFFORT], problem: null });
  });

  it('offers nothing, and says nothing, for a new provider with no fields and no settings', () => {
    expect(
      localAdvancedFields(
        { id: 'newcli', label: 'New CLI' },
        { surface: 'none', keys: [] },
        { kind: 'schema', schema: { newcli: [] } }
      )
    ).toEqual({ fields: [], problem: null });
  });

  it('offers nothing while the server’s fields load', () => {
    expect(
      localAdvancedFields(CODEX, { surface: 'launch-profile', keys: [] }, { kind: 'loading' })
    ).toEqual({ fields: [], problem: null });
  });

  it('says there is no server to read the fields from, and offers only the model', () => {
    const result = localAdvancedFields(
      CODEX,
      { surface: 'launch-profile', keys: ['effort'] },
      { kind: 'no-server' }
    );
    expect(result.fields.map((field) => field.key)).toEqual(['model']);
    expect(result.problem).toBe(
      'There is no Switch server to read the advanced configuration fields from, so only the model can be set.'
    );
    expect(
      localAdvancedFields(CODEX, { surface: 'none', keys: [] }, { kind: 'no-server' }).problem
    ).toBe('There is no Switch server to read the advanced configuration fields from.');
  });
});

describe('choicesNotOffered', () => {
  it('names a saved choice the server’s field does not offer', () => {
    expect(choicesNotOffered([EFFORT], { effort: 'High' })).toMatch(
      /Reasoning effort is “High”, which the Switch server does not offer/
    );
  });

  it('is null for offered and unset choices', () => {
    expect(choicesNotOffered([EFFORT], { effort: 'high' })).toBeNull();
    expect(choicesNotOffered([EFFORT], { effort: '' })).toBeNull();
    expect(choicesNotOffered([EFFORT], {})).toBeNull();
  });
});
