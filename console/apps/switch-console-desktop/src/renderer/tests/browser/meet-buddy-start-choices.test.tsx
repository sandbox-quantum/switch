/**
 * How Meet switch-buddy offers to start the buddy: with a provider already
 * signed in, those and another provider, no Skip; with none, set one up or
 * skip.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/components/agent-icon', () => ({
  AgentIcon: ({ id }: { id: string }) => <span data-provider-icon={id} />,
}));

import { StartChoices } from '@renderer/features/switch-buddy/meet-buddy-page';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const handlers = () => ({ onStart: vi.fn(), onSetUp: vi.fn(), onSkip: vi.fn() });

async function render(props: React.ComponentProps<typeof StartChoices>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<StartChoices {...props} />));
}

function buttons(): string[] {
  return [...container!.querySelectorAll('button')].map((button) => button.textContent ?? '');
}

describe('Meet switch-buddy start choices', () => {
  it('offers the providers already signed in, and another, with no Skip', async () => {
    const on = handlers();
    await render({
      checking: false,
      ready: [
        { id: 'claude', name: 'Claude Code' },
        { id: 'codex', name: 'Codex' },
      ],
      starting: null,
      ...on,
    });
    expect(container!.textContent).toContain('How’d you like to power switch-buddy?');
    expect(container!.textContent).toContain('Already signed in:');
    expect(buttons()).toEqual(['Claude Code', 'Codex', 'Use other AI providers']);
    expect(
      [...container!.querySelectorAll('[data-provider-icon]')].map((icon) =>
        icon.getAttribute('data-provider-icon')
      )
    ).toEqual(['claude', 'codex']);
    await act(async () => container!.querySelectorAll('button')[1]!.click());
    expect(on.onStart).toHaveBeenCalledWith('codex');
  });

  it('offers to set one up, or skip, when none is signed in', async () => {
    const on = handlers();
    await render({ checking: false, ready: [], starting: null, ...on });
    expect(buttons()).toEqual(['Skip', 'Set up AI provider']);
    await act(async () => container!.querySelectorAll('button')[0]!.click());
    expect(on.onSkip).toHaveBeenCalled();
  });

  it('offers nothing while the providers are being checked', async () => {
    await render({ checking: true, ready: [], starting: null, ...handlers() });
    expect(buttons()).toEqual([]);
    expect(container!.textContent).toContain('Checking AI providers…');
  });
});
