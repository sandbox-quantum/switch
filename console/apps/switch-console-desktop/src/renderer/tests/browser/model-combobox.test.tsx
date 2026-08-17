import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The combobox's siblings reach the renderer IPC bridge at import time, which
// only exists inside Electron. Hoisted so it is in place before those modules
// are evaluated. Nothing under test calls through it.
vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

import { DefinitionFieldInput } from '@renderer/features/locations/components/agent-definition-fields';

/**
 * The model field has to stay typeable.
 *
 * The host catalogue is a snapshot of a machine that changes without us — a
 * model can be pulled a second after it was read — so the list is a shortcut,
 * not a constraint. A `select` here would have made an unlisted model
 * unreachable, which is why this renders as a combobox and why that is worth
 * pinning in a real browser rather than asserting on props.
 */
const MODELS = [
  { id: 'ollama/gemma4:latest', variants: [] },
  { id: 'google/gemini-2.5-flash', variants: ['high', 'max'] },
];

const FIELD = {
  key: 'model',
  label: 'Model',
  type: 'text' as const,
  placeholder: 'e.g. anthropic/claude-sonnet-4-5',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('the model field, given a host catalogue', () => {
  it('renders a text box you can type into, not a fixed list', async () => {
    const host = await render(
      <DefinitionFieldInput field={FIELD} value="" suggestions={MODELS} onChange={() => {}} />
    );

    const input = host.querySelector('input');
    expect(input).not.toBeNull();
    expect(input?.tagName).toBe('INPUT');
    expect(host.querySelector('select')).toBeNull();
  });

  it('shows a model the host does not offer, rather than clearing it', async () => {
    // A value typed before the catalogue was read, or one for a model about to
    // be pulled, must survive being displayed.
    const host = await render(
      <DefinitionFieldInput
        field={FIELD}
        value="ollama/not-pulled-yet"
        suggestions={MODELS}
        onChange={() => {}}
      />
    );

    expect(host.querySelector('input')?.value).toBe('ollama/not-pulled-yet');
  });

  it('reports what was typed, including a name not in the catalogue', async () => {
    const seen: unknown[] = [];
    const host = await render(
      <DefinitionFieldInput
        field={FIELD}
        value=""
        suggestions={MODELS}
        onChange={(next) => seen.push(next)}
      />
    );

    const input = host.querySelector('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(input, 'ollama/brand-new');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(seen).toContain('ollama/brand-new');
  });

  it('falls back to a plain input when there is no catalogue to offer', async () => {
    const host = await render(
      <DefinitionFieldInput field={FIELD} value="typed" onChange={() => {}} />
    );

    expect(host.querySelector('input')?.value).toBe('typed');
  });
});
