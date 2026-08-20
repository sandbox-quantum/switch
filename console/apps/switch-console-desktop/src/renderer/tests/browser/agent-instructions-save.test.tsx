/**
 * Editing an agent's instructions from its page (CHOO-2228).
 *
 * The instructions are a main attribute of the agent, so they sit at the top of
 * the page rather than inside advanced configuration — and they are saved from
 * a bar shared with the other editors on the page, not a button of their own.
 * These pin what that bar owes the reader: it appears only when something is
 * genuinely unsaved, nothing is written until Save, and Revert puts back what
 * was stored rather than clearing the field.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readInstructions = vi.hoisted(() => vi.fn());
const updateInstructions = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    agents: { readInstructions, updateInstructions },
  },
}));

import { AgentEditsProvider } from '@renderer/features/locations/components/main-panel/agent-edits';
import { AgentInstructionsSection } from '@renderer/features/locations/components/main-panel/agent-instructions-section';
import { AgentSaveBar } from '@renderer/features/locations/components/main-panel/agent-save-bar';

const STORED = 'Answer in French.';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  readInstructions.mockReset();
  readInstructions.mockResolvedValue(STORED);
  updateInstructions.mockReset();
  updateInstructions.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderPage(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentEditsProvider>
          <AgentInstructionsSection locationId="loc-1" agentId="agent-1" />
          <AgentSaveBar />
        </AgentEditsProvider>
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

function field(el: HTMLElement): HTMLTextAreaElement {
  return el.querySelector<HTMLTextAreaElement>('textarea')!;
}

function button(el: HTMLElement, label: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    label.test(b.textContent?.trim() ?? '')
  );
}

/** Type into a controlled textarea the way React will notice. */
async function type(target: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('an agent’s instructions', () => {
  it('shows what is stored', async () => {
    const el = await renderPage();

    expect(field(el).value).toBe(STORED);
  });

  it('offers no save bar until something is edited', async () => {
    const el = await renderPage();

    expect(el.textContent).not.toContain('Unsaved changes');
    expect(button(el, /^Save/)).toBeUndefined();
  });

  it('says there are unsaved changes once edited', async () => {
    const el = await renderPage();
    await type(field(el), 'Answer in Portuguese.');

    expect(el.textContent).toContain('Unsaved changes');
    expect(button(el, /^Save/)).toBeDefined();
  });

  it('writes nothing until Save is pressed', async () => {
    const el = await renderPage();
    const target = field(el);
    await type(target, 'Answer in Portuguese.');
    await act(async () => target.dispatchEvent(new FocusEvent('blur', { bubbles: true })));

    expect(updateInstructions).not.toHaveBeenCalled();
  });

  it('saves the edit, then has nothing left to save', async () => {
    const el = await renderPage();
    await type(field(el), 'Answer in Portuguese.');
    readInstructions.mockResolvedValue('Answer in Portuguese.');

    await act(async () => button(el, /^Save/)!.click());
    for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());

    expect(updateInstructions).toHaveBeenCalledWith({
      agentId: 'agent-1',
      instructions: 'Answer in Portuguese.',
    });
    expect(el.textContent).not.toContain('Unsaved changes');
  });

  it('reverts to what is stored rather than emptying the box', async () => {
    const el = await renderPage();
    await type(field(el), 'Answer in Portuguese.');

    await act(async () => button(el, /^Revert/)!.click());

    expect(field(el).value).toBe(STORED);
    expect(updateInstructions).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain('Unsaved changes');
  });

  it('saves an emptied box, which is how instructions are cleared', async () => {
    // Empty is a real state — the agent then has none — so it has to be
    // savable rather than read as "nothing to do".
    const el = await renderPage();
    await type(field(el), '');
    readInstructions.mockResolvedValue('');

    expect(el.textContent).toContain('Unsaved changes');
    await act(async () => button(el, /^Save/)!.click());
    for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());

    expect(updateInstructions).toHaveBeenCalledWith({ agentId: 'agent-1', instructions: '' });
  });
});
