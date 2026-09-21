import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepPager } from '@renderer/lib/ui/step-pager';

/**
 * The pager is the only thing on a wizard page that says where you are, and its
 * arrows are unlabelled. So what matters is that an arrow with nowhere to go
 * cannot be pressed: a page that is mid-install passes no way back, and a
 * chevron that fired anyway would abandon the install with nothing watching it.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

// Matched on the start of the label, because an arrow leading nowhere appends
// the reason to its own.
function arrow(el: HTMLElement, label: string): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`);
  expect(found).not.toBeNull();
  return found!;
}

describe('the pager on a wizard page', () => {
  it('names the page and moves either way when both are open', async () => {
    const onBack = vi.fn();
    const onNext = vi.fn();
    const el = await render(
      <StepPager pageName="Connect to a server" onBack={onBack} onNext={onNext} />
    );

    expect(el.textContent).toContain('Connect to a server');

    await act(async () => arrow(el, 'Previous page').click());
    await act(async () => arrow(el, 'Next page').click());

    expect(onBack).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  // Shown rather than hidden: the bar keeps the same shape from page to page,
  // so the name does not move as the flow advances.
  it('keeps an arrow with nowhere to go on screen and dead', async () => {
    const onBack = vi.fn();
    const el = await render(<StepPager pageName="Sign in" onBack={onBack} onNext={null} />);

    const next = arrow(el, 'Next page');
    // However the button primitive spells it, it has to reach a screen reader
    // as unavailable — the chevron itself says nothing about where it leads.
    expect(next.matches(':disabled, [aria-disabled="true"], [data-disabled]')).toBe(true);

    await act(async () => next.click());

    expect(onBack).not.toHaveBeenCalled();
  });

  it('leaves the dead arrow reachable, with the reason in its label', async () => {
    // `disabled` would take it out of the tab order, and the label is the only
    // place the reason is written — so the people who cannot see the greyed-out
    // chevron would be the ones who never hear why it leads nowhere.
    const el = await render(<StepPager pageName="Sign in" onBack={null} onNext={null} />);

    for (const label of ['Previous page', 'Next page']) {
      const button = arrow(el, label);
      expect(button.hasAttribute('disabled')).toBe(false);
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      expect(button.getAttribute('aria-label')!.length).toBeGreaterThan(label.length);
    }
  });
});
