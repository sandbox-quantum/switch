/**
 * How Meet switch-buddy offers to start the buddy: with a provider already
 * signed in, a tile for each and a link to the others, no Skip; with none, set one up or
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

/** The choices offered: every button but the heading's explanation of what a provider is. */
function choices(): HTMLButtonElement[] {
  return [...container!.querySelectorAll('button')].filter((button) => !button.closest('h2'));
}

function buttons(): string[] {
  return choices().map((button) => button.textContent ?? '');
}

describe('Meet switch-buddy start choices', () => {
  it('offers the providers already signed in, and another, with no Skip', async () => {
    const on = handlers();
    await render({
      checking: false,
      ready: [
        { id: 'claude', name: 'Claude Code', unchecked: false, detail: null },
        { id: 'codex', name: 'Codex', unchecked: false, detail: null },
      ],
      starting: null,
      ...on,
    });
    expect(container!.textContent).toContain('Pick an AI provider to get started');
    expect(buttons()).toEqual([
      'Claude CodeSigned in locally',
      'CodexSigned in locally',
      'use other providers',
    ]);
    expect(
      [...container!.querySelectorAll('[data-provider-icon]')].map((icon) =>
        icon.getAttribute('data-provider-icon')
      )
    ).toEqual(['claude', 'codex']);
    await act(async () => choices()[1]!.click());
    expect(on.onStart).toHaveBeenCalledWith('codex');
  });

  it('offers a provider whose sign-in could not be checked, saying so', async () => {
    const on = handlers();
    await render({
      checking: false,
      ready: [
        {
          id: 'claude',
          name: 'Claude Code',
          unchecked: true,
          detail: 'The sign-in check failed: it exited 3',
        },
      ],
      starting: null,
      ...on,
    });
    expect(buttons()).toEqual(['Claude CodeCouldn’t check sign-in', 'use other providers']);
    expect(container!.querySelector('[role="status"]')?.textContent).toBe(
      'Claude Code’s sign-in couldn’t be checked: The sign-in check failed: it exited 3. You can still start with it. If it isn’t signed in, switch-buddy won’t answer until it is.'
    );
    await act(async () => choices()[0]!.click());
    expect(on.onStart).toHaveBeenCalledWith('claude');
  });

  it('offers to set one up, or skip, when none is signed in', async () => {
    const on = handlers();
    await render({ checking: false, ready: [], starting: null, ...on });
    expect(buttons()).toEqual(['Set up AI provider', 'Skip']);
    await act(async () => choices()[1]!.click());
    expect(on.onSkip).toHaveBeenCalled();
  });

  it('offers nothing while the providers are being checked', async () => {
    await render({ checking: true, ready: [], starting: null, ...handlers() });
    expect(buttons()).toEqual([]);
    expect(container!.textContent).toContain('Checking AI providers…');
  });
});
