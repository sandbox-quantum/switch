import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelCombobox } from '@renderer/features/locations/components/model-combobox';

/**
 * Pressing Enter on a model the loaded list does not contain must keep it.
 *
 * The combobox answers an unmatched Enter by clearing the box ('input-clear'),
 * which wiped a model id the user had typed on purpose — and an id the host does
 * not currently offer is a routine, valid thing to type, since the catalogue is
 * only a snapshot.
 */

const MODELS = [
  { id: 'ollama/gemma4:latest', variants: [] },
  { id: 'google/gemini-2.5-flash', variants: ['high', 'max'] },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <ModelCombobox id="model" value={value} models={MODELS} onChange={setValue} />;
}

async function render(value = '') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness initial={value} />));
  return container.querySelector('input')!;
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
    );
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
}

describe('pressing Enter in the model field', () => {
  it('keeps a typed model that is not in the list', async () => {
    const input = await render();
    await type(input, 'claude-opus-5-5[1m]');
    expect(input.value).toBe('claude-opus-5-5[1m]');

    await pressEnter(input);

    expect(input.value).toBe('claude-opus-5-5[1m]');
  });

  it('commits a model the list does contain', async () => {
    const input = await render();
    await type(input, 'ollama/gemma4:latest');
    await pressEnter(input);

    expect(input.value).toBe('ollama/gemma4:latest');
  });

  it('still lets the field be emptied by deleting the text', async () => {
    const input = await render('some-model');
    await type(input, '');

    expect(input.value).toBe('');
  });
});
