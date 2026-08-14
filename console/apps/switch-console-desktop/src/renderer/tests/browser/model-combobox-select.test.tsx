import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

import { ModelCombobox } from '@renderer/features/locations/components/model-combobox';

/**
 * Picking a model from the list has to put the model's id in the box.
 *
 * It did not: the list was built from model objects, and the combobox fills the
 * input by stringifying the item it was given, so choosing one wrote
 * `[object Object]`. Every subsequent check then failed to match it against the
 * catalogue, so the field warned about a model the user had just picked from
 * that same catalogue.
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

/**
 * A harness that actually re-renders on change.
 *
 * The field is controlled, so a test that records changes without feeding them
 * back leaves the input showing its initial value and the combobox reacting to
 * a value the user never sees. That harness reported the list as broken when it
 * was not, and would equally have hidden a real break.
 */
function Harness({ onChange, initial }: { onChange: (value: string) => void; initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ModelCombobox
      id="model"
      value={value}
      models={MODELS}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

async function renderCombobox(onChange: (value: string) => void, value = '') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness onChange={onChange} initial={value} />);
  });
  return container;
}

/** Type into the field the way a person does, as one controlled change. */
async function typeInto(host: HTMLElement, text: string) {
  const input = host.querySelector('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

const shownItems = () =>
  Array.from(document.querySelectorAll('[data-slot="combobox-item"]')).map(
    (node) => node.textContent ?? ''
  );

/**
 * Open the popup the way a user does, and return its rendered options.
 *
 * A bare `.click()` is not enough — the combobox opens on the pointer sequence,
 * and a test that only clicks leaves it shut, then finds no items and concludes
 * nothing is wrong. That is how a broken list passed review.
 */
async function openList(host: HTMLElement): Promise<HTMLElement[]> {
  const trigger = host.querySelector('button')!;
  await act(async () => {
    for (const type of ['pointerdown', 'pointerup'] as const) {
      trigger.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }));
    }
    for (const type of ['mousedown', 'mouseup'] as const) {
      trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
    }
    trigger.click();
  });

  const input = host.querySelector('input')!;
  expect(input.getAttribute('aria-expanded')).toBe('true');
  // The popup is portalled, so it is not inside `host`.
  return Array.from(document.querySelectorAll('[data-slot="combobox-item"]'));
}

describe('picking a model from the list', () => {
  it('puts the model id in the box, not the object behind it', async () => {
    const seen: string[] = [];
    const host = await renderCombobox((next) => seen.push(next));

    const items = await openList(host);
    expect(items.length).toBeGreaterThan(0);

    const gemma = items.find((item) => item.textContent?.includes('ollama/gemma4:latest'));
    expect(gemma).toBeDefined();
    await act(async () => gemma!.click());

    expect(seen).toContain('ollama/gemma4:latest');
    for (const value of seen) {
      expect(value).not.toContain('object Object');
      expect(value).not.toContain('{');
    }
  });

  it('lists every model the host offers', async () => {
    const host = await renderCombobox(() => {});
    const items = await openList(host);
    const text = items.map((item) => item.textContent ?? '').join('\n');

    for (const model of MODELS) expect(text).toContain(model.id);
  });

  it('shows what a model reasons with, so the variant choice is predictable', async () => {
    const host = await renderCombobox(() => {});
    const items = await openList(host);

    const flash = items.find((item) => item.textContent?.includes('google/gemini-2.5-flash'));
    expect(flash?.textContent).toContain('high');
    expect(flash?.textContent).toContain('max');
  });
});

describe('typing in the model field', () => {
  it('opens the list and narrows it to what matches', async () => {
    // This did not work: the field is controlled, so the combobox read a typed
    // change as programmatic and stayed shut. The list was reachable only via
    // the chevron, which is not where anyone looks.
    const host = await renderCombobox(() => {});
    const input = await typeInto(host, 'oll');

    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(shownItems()).toEqual(['ollama/gemma4:latest']);
  });

  it('keeps what was typed, even with nothing to match it', async () => {
    const host = await renderCombobox(() => {});
    const input = await typeInto(host, 'ollama/not-pulled-yet');

    expect(input.value).toBe('ollama/not-pulled-yet');
    expect(shownItems()).toEqual([]);
  });
});
