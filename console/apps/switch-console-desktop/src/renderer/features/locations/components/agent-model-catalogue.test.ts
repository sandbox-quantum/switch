import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import {
  fieldCatalogueState,
  fieldWithCatalogue,
  type ModelCatalogueResult,
} from './agent-model-catalogue';

const modelField: RepoAgentField = {
  key: 'model',
  label: 'Model',
  type: 'text',
  catalogue: { kind: 'model' },
};

const variantField: RepoAgentField = {
  key: 'variant',
  label: 'Reasoning variant',
  type: 'text',
  catalogue: { kind: 'model-variant', modelField: 'model' },
};

const plainField: RepoAgentField = { key: 'instructions', label: 'Instructions', type: 'textarea' };

const CATALOGUE: ModelCatalogueResult = {
  kind: 'available',
  models: [
    { id: 'ollama/gemma4:latest', variants: [] },
    { id: 'google/gemini-2.5-flash', variants: ['high', 'max'] },
  ],
};

describe('fieldCatalogueState', () => {
  it('leaves a field that declares no binding alone', () => {
    expect(fieldCatalogueState(plainField, { instructions: 'hi' }, CATALOGUE)).toEqual({});
  });

  it('says nothing while the catalogue is still loading', () => {
    expect(fieldCatalogueState(modelField, { model: 'anything' }, undefined)).toEqual({});
  });

  describe('the model field', () => {
    it('accepts a model the host offers without comment', () => {
      const state = fieldCatalogueState(modelField, { model: 'ollama/gemma4:latest' }, CATALOGUE);

      expect(state.note).toBeUndefined();
      expect(state.warning).toBeFalsy();
    });

    it('offers the host’s models whatever is currently typed', () => {
      // The list is a way to discover what this host has, not only a check on
      // what was typed, so it is offered for a valid, blank or unknown value.
      for (const model of ['ollama/gemma4:latest', '', 'ollama/typo']) {
        expect(fieldCatalogueState(modelField, { model }, CATALOGUE).suggestions).toEqual(
          CATALOGUE.kind === 'available' ? CATALOGUE.models : []
        );
      }
    });

    it('warns about a model the host does not offer, and still allows it', () => {
      // Warns rather than blocks: the catalogue is a snapshot of a machine that
      // changes without us, and the model may be about to exist.
      const state = fieldCatalogueState(modelField, { model: 'ollama/typo' }, CATALOGUE);

      expect(state.warning).toBe(true);
      expect(state.note).toContain('ollama/typo');
      expect(state.disabled).toBeFalsy();
    });

    it('says nothing about a blank model, which means the host default', () => {
      const state = fieldCatalogueState(modelField, { model: '  ' }, CATALOGUE);

      expect(state.note).toBeUndefined();
      expect(state.warning).toBeFalsy();
    });
  });

  describe('the reasoning-variant field', () => {
    it('offers exactly the variants the chosen model accepts', () => {
      const state = fieldCatalogueState(
        variantField,
        { model: 'google/gemini-2.5-flash' },
        CATALOGUE
      );

      expect(state.options).toEqual([
        { value: '', label: 'Default' },
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' },
      ]);
      expect(state.disabled).toBeFalsy();
    });

    it('disables itself for a model with no variants, and says why', () => {
      // The Ollama case. OpenCode would accept a variant here and ignore it in
      // silence, so the field says so instead of looking configurable.
      const state = fieldCatalogueState(variantField, { model: 'ollama/gemma4:latest' }, CATALOGUE);

      expect(state.disabled).toBe(true);
      expect(state.note).toContain('no reasoning variants');
    });

    it('warns when a value left over from another model would be ignored', () => {
      const state = fieldCatalogueState(
        variantField,
        { model: 'google/gemini-2.5-flash', variant: 'xhigh' },
        CATALOGUE
      );

      expect(state.warning).toBe(true);
      expect(state.note).toContain('would be ignored');
      expect(state.options).toBeDefined();
    });

    it('asks for a model first rather than guessing which variants apply', () => {
      const state = fieldCatalogueState(variantField, { model: '' }, CATALOGUE);

      expect(state.note).toContain('Choose a model');
      expect(state.warning).toBeFalsy();
    });

    it('stays quiet when the model itself is the problem', () => {
      // The model field already flags it; two warnings for one mistake is noise.
      expect(fieldCatalogueState(variantField, { model: 'ollama/typo' }, CATALOGUE)).toEqual({});
    });
  });

  describe('when the host could not be asked', () => {
    const unavailable: ModelCatalogueResult = { kind: 'unavailable', reason: 'Ran out of coffee.' };

    it('says so on a bound field rather than pretending the value is checked', () => {
      const state = fieldCatalogueState(modelField, { model: 'whatever' }, unavailable);

      expect(state.note).toContain('Ran out of coffee.');
      expect(state.warning).toBeFalsy();
    });

    it('offers no suggestions, so the field stays a plain box', () => {
      expect(
        fieldCatalogueState(modelField, { model: 'x' }, unavailable).suggestions
      ).toBeUndefined();
    });

    it('leaves the field usable, with the type its provider declared', () => {
      const state = fieldCatalogueState(variantField, { model: 'x', variant: 'y' }, unavailable);

      expect(state.disabled).toBeFalsy();
      expect(fieldWithCatalogue(variantField, state).type).toBe('text');
    });
  });
});

describe('fieldWithCatalogue', () => {
  it('turns a field into a select once the catalogue supplies choices', () => {
    const state = fieldCatalogueState(
      variantField,
      { model: 'google/gemini-2.5-flash' },
      CATALOGUE
    );
    const rendered = fieldWithCatalogue(variantField, state);

    expect(rendered.type).toBe('select');
    expect(rendered.options).toEqual(state.options);
  });

  it('leaves the declared type in place when there are no choices to offer', () => {
    expect(fieldWithCatalogue(modelField, {})).toBe(modelField);
  });
});
