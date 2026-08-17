import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OnboardingChecklistCard,
  OnboardingChecklistPanel,
} from '@renderer/features/onboarding/onboarding-checklist';
import { deriveOnboardingSteps } from '@shared/core/onboarding/checklist';

/**
 * The sidebar setup checklist's rendered states (CHOO-2022). The panel is
 * presentational — progress and actions are passed in — so these assertions are
 * about what a given progress actually puts on screen.
 */

let container: HTMLDivElement | null = null;

async function renderPanel(
  options: {
    progress?: Partial<Record<string, boolean>>;
    collapsed?: boolean;
    onStart?: (id: string) => void;
    onDismiss?: () => void;
    onToggleCollapsed?: () => void;
  } = {}
): Promise<HTMLDivElement> {
  const progress = {
    addServer: false,
    agentProviders: false,
    onboardAgents: false,
    createRoom: false,
    ...options.progress,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <OnboardingChecklistPanel
        steps={deriveOnboardingSteps(progress)}
        complete={Object.values(progress).every(Boolean)}
        collapsed={options.collapsed ?? false}
        onStart={options.onStart ?? (() => {})}
        onToggleCollapsed={options.onToggleCollapsed ?? (() => {})}
        onDismiss={options.onDismiss ?? (() => {})}
      />
    )
  );
  return container;
}

async function renderCard(
  options: {
    progress?: Partial<Record<string, boolean>>;
    onStart?: (id: string) => void;
    onDismiss?: () => void;
  } = {}
): Promise<HTMLDivElement> {
  const progress = {
    addServer: true,
    agentProviders: true,
    onboardAgents: true,
    createRoom: true,
    ...options.progress,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <OnboardingChecklistCard
        steps={deriveOnboardingSteps(progress)}
        complete={Object.values(progress).every(Boolean)}
        onStart={options.onStart ?? (() => {})}
        onDismiss={options.onDismiss ?? (() => {})}
      />
    )
  );
  return container;
}

function stepButton(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label
  ) as HTMLButtonElement | undefined;
}

afterEach(() => {
  container?.remove();
  container = null;
});

describe('onboarding checklist panel', () => {
  it('lists every step on a fresh install', async () => {
    const el = await renderPanel();

    for (const label of [
      'Add a server',
      'Set up agent providers',
      'Onboard your agents',
      'Create a room',
    ]) {
      expect(stepButton(el, label), label).toBeDefined();
    }
  });

  it('strikes through a completed step and leaves the rest alone', async () => {
    const el = await renderPanel({ progress: { addServer: true } });

    expect(stepButton(el, 'Add a server')?.innerHTML).toContain('line-through');
    expect(stepButton(el, 'Set up agent providers')?.innerHTML).not.toContain('line-through');
  });

  it('withholds the completion message until every step is done', async () => {
    const partial = await renderPanel({
      progress: { addServer: true, agentProviders: true, onboardAgents: true },
    });
    expect(partial.textContent).not.toContain('All set!');
    partial.remove();

    const done = await renderPanel({
      progress: {
        addServer: true,
        agentProviders: true,
        onboardAgents: true,
        createRoom: true,
      },
    });
    expect(done.textContent).toContain('All set!');
    expect(done.textContent).toContain('Learn more');
  });

  it('hides the steps when collapsed but keeps the header', async () => {
    const el = await renderPanel({ collapsed: true });

    expect(el.textContent).toContain('Setting up Switch');
    expect(stepButton(el, 'Add a server')).toBeUndefined();
  });

  it('reports which step was started', async () => {
    const onStart = vi.fn();
    const el = await renderPanel({
      progress: { addServer: true, agentProviders: true, onboardAgents: true },
      onStart,
    });

    await act(async () => stepButton(el, 'Create a room')?.click());

    expect(onStart).toHaveBeenCalledWith('createRoom');
  });

  it('refuses to start a step behind an unfinished one', async () => {
    const onStart = vi.fn();
    const el = await renderPanel({ onStart });

    const locked = stepButton(el, 'Create a room');
    expect(locked?.disabled).toBe(true);

    await act(async () => locked?.click());
    expect(onStart).not.toHaveBeenCalled();
  });

  it('keeps a completed step startable so it can be revisited', async () => {
    const onStart = vi.fn();
    const el = await renderPanel({ progress: { addServer: true }, onStart });

    const done = stepButton(el, 'Add a server');
    expect(done?.disabled).toBe(false);

    await act(async () => done?.click());
    expect(onStart).toHaveBeenCalledWith('addServer');
  });

  it('does not repeat the doc links on the welcome card, which has its own', async () => {
    const el = await renderCard();

    expect(el.textContent).toContain('All set!');
    expect(el.textContent).not.toContain('Learn more');
  });

  it('lets the welcome card be dismissed too, not just the sidebar panel', async () => {
    const onDismiss = vi.fn();
    const el = await renderCard({ onDismiss });

    const dismiss = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss setup checklist"]'
    );
    expect(dismiss, 'the welcome card needs a dismiss control of its own').not.toBeNull();

    await act(async () => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('offers no collapse on the welcome card, where there is no space to reclaim', async () => {
    const el = await renderCard();

    expect(el.querySelector('button[aria-label="Collapse setup checklist"]')).toBeNull();
  });

  it('dismisses through its own control rather than collapsing', async () => {
    const onDismiss = vi.fn();
    const onToggleCollapsed = vi.fn();
    const el = await renderPanel({ onDismiss, onToggleCollapsed });

    const dismiss = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss setup checklist"]'
    );
    await act(async () => dismiss?.click());

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });
});
