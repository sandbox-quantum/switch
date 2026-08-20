/**
 * How much of the page an agent's instructions are allowed to take (CHOO-2203).
 *
 * The box grows with its content, and nothing capped it — so an agent carrying
 * a real prompt turned its page into one long textarea with the settings below
 * pushed out of sight. These pin the ceiling and the way out of it, both of
 * which are invisible to the save tests next door: a box of the wrong height
 * still holds the right text.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Heights are the whole subject here, so the real utility classes have to be
// present — without this the box renders at the browser's own default size.
import '@renderer/index.css';

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

const SHORT = 'Answer in French.';
/** A prompt of the size that provoked the report — far past any ceiling. */
const LONG = Array.from({ length: 120 }, (_, i) => `Instruction line ${i + 1}.`).join('\n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  readInstructions.mockReset();
  updateInstructions.mockReset();
  updateInstructions.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderSection(stored: string): Promise<HTMLDivElement> {
  readInstructions.mockResolvedValue(stored);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentEditsProvider>
          <AgentInstructionsSection locationId="loc-1" agentId="agent-1" />
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

function toggle(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    /^(Expand|Collapse)$/.test(b.textContent?.trim() ?? '')
  );
}

describe('an agent’s instructions box', () => {
  it('stops growing well before it fills a page', async () => {
    const el = await renderSection(LONG);
    const box = field(el);

    // The ceiling itself, not the exact number: what matters is that a
    // 120-line prompt cannot push the sections below it off the screen.
    expect(box.clientHeight).toBeLessThan(320);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  });

  it('offers a way to open it when it is holding back text', async () => {
    const el = await renderSection(LONG);

    expect(toggle(el)?.textContent?.trim()).toBe('Expand');
  });

  it('offers nothing to open when everything already fits', async () => {
    const el = await renderSection(SHORT);

    expect(toggle(el)).toBeUndefined();
  });

  it('shows the whole prompt once expanded, and offers the way back', async () => {
    const el = await renderSection(LONG);
    const capped = field(el).clientHeight;

    await act(async () => toggle(el)!.click());

    const box = field(el);
    expect(box.clientHeight).toBeGreaterThan(capped);
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
    expect(toggle(el)?.textContent?.trim()).toBe('Collapse');
  });

  it('puts the ceiling back when collapsed again', async () => {
    const el = await renderSection(LONG);
    await act(async () => toggle(el)!.click());

    await act(async () => toggle(el)!.click());

    expect(field(el).clientHeight).toBeLessThan(320);
    expect(toggle(el)?.textContent?.trim()).toBe('Expand');
  });
});
