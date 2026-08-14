import { describe, expect, it } from 'vitest';
import { groupByProvider } from './model-combobox';

const model = (id: string, variants: string[] = []) => ({ id, variants });

describe('groupByProvider', () => {
  it('groups models under the provider their id names', () => {
    expect(
      groupByProvider([
        model('google/gemini-2.5-flash', ['high']),
        model('ollama/gemma4:latest'),
        model('google/gemini-2.5-pro', ['high', 'max']),
      ])
    ).toEqual([
      { value: 'google', items: ['google/gemini-2.5-flash', 'google/gemini-2.5-pro'] },
      { value: 'ollama', items: ['ollama/gemma4:latest'] },
    ]);
  });

  it('keeps the host’s own ordering rather than sorting', () => {
    // The order OpenCode lists them in is its preference — the default model
    // first — and re-sorting would bury it.
    const groups = groupByProvider([model('z/one'), model('a/two')]);
    expect(groups.map((group) => group.value)).toEqual(['z', 'a']);
  });

  it('keeps a local provider as its own group beside the cloud ones', () => {
    // The point of the field is that a local model sits alongside the rest;
    // forty entries in one flat list hides that.
    const groups = groupByProvider([model('google/a'), model('ollama/b'), model('google/c')]);
    expect(groups).toHaveLength(2);
  });

  it('survives an id with no provider prefix rather than dropping it', () => {
    expect(groupByProvider([model('bare')])).toEqual([{ value: 'bare', items: ['bare'] }]);
  });

  it('yields plain id strings, which is what the combobox can stringify', () => {
    // The combobox fills the input by stringifying the item it was handed, via
    // the item's `label` or `value`. A `{id, variants}` object has neither, so
    // picking one wrote a serialized object into the field — and the wrapper
    // exposes no hook to correct that. The item has to be the string itself.
    for (const group of groupByProvider([model('a/one'), model('b/two', ['high'])])) {
      for (const item of group.items) expect(typeof item).toBe('string');
    }
  });

  it('returns nothing for nothing', () => {
    expect(groupByProvider([])).toEqual([]);
  });
});
