import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOpencodeModels } from './models';

/**
 * Real `opencode models --verbose` output, captured from opencode 1.18.18.
 *
 * Fixtures rather than hand-written samples because the format is the one thing
 * here we do not control: OpenCode has no machine-readable flag for this, so an
 * upgrade that reshapes the output is what would break the catalogue, and a
 * sample written to match the parser could not catch that.
 */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', `models-verbose-${name}.txt`), 'utf8');

describe('parseOpencodeModels', () => {
  it('reads a local model, which declares no variants', () => {
    // The Ollama case: this is what makes the variant field inert for a local
    // model, and it is reported rather than guessed.
    expect(parseOpencodeModels(fixture('ollama'))).toEqual([
      { id: 'ollama/gemma4:latest', variants: [] },
    ]);
  });

  it('reads the variants a cloud model actually accepts', () => {
    expect(parseOpencodeModels(fixture('google'))).toEqual([
      { id: 'google/gemini-2.5-flash', variants: ['high', 'max'] },
      { id: 'google/gemini-2.5-flash-lite', variants: ['high', 'max'] },
    ]);
  });

  it('keys models the way the model field is typed', () => {
    // The field takes `provider/model`, so a typed value can be compared to the
    // catalogue without either side reformatting.
    for (const model of parseOpencodeModels(fixture('google'))) {
      expect(model.id).toMatch(/^[^/]+\/.+$/);
    }
  });

  it('is not fooled by the nested objects inside a model', () => {
    // Blocks are delimited by a brace alone on a line, which the pretty-printer
    // only emits at the top level — `api`, `cost` and `variants` are indented.
    const models = parseOpencodeModels(fixture('google'));
    expect(models).toHaveLength(2);
  });

  it('skips a block cut off at the end rather than losing the whole catalogue', () => {
    const truncated = `${fixture('ollama')}google/half-written\n{\n  "id": "half-written",\n`;
    expect(parseOpencodeModels(truncated)).toEqual([{ id: 'ollama/gemma4:latest', variants: [] }]);
  });

  it('skips a block that is not valid JSON, keeping the ones that are', () => {
    const broken = `google/bad\n{\n  not json\n}\n${fixture('ollama')}`;
    expect(parseOpencodeModels(broken)).toEqual([{ id: 'ollama/gemma4:latest', variants: [] }]);
  });

  it('skips a model missing the ids the field is keyed on', () => {
    expect(parseOpencodeModels('x\n{\n  "name": "no ids"\n}\n')).toEqual([]);
  });

  it('returns nothing for output it cannot read at all', () => {
    // The caller treats an empty catalogue as unavailable and says so, rather
    // than reporting that the host offers no models.
    expect(parseOpencodeModels('')).toEqual([]);
    expect(parseOpencodeModels('command not found: opencode\n')).toEqual([]);
  });
});
