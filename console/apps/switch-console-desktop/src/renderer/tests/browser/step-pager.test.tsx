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
    const el = await render(<StepPager pageName="Sign in" onBack={vi.fn()} onNext={null} />);

    const next = arrow(el, 'Next page');
    // However the button primitive spells it, it has to reach a screen reader
    // as unavailable — the chevron itself says nothing about where it leads.
    expect(next.matches(':disabled, [aria-disabled="true"], [data-disabled]')).toBe(true);
  });

  /**
   * The same arrow, the same handler, closed and then open.
   *
   * `aria-disabled` leaves the button clickable — that is the price of keeping
   * it in the tab order — so nothing but the missing handler stops it firing,
   * and a page whose way on commits an install would be committed by a chevron
   * labelled "next". Driving one button through both states is what makes this
   * a test: asserting on a separate always-dead arrow would pass against an
   * implementation that fires whatever it is given.
   */
  it('fires nothing while the way on is closed, and fires once when it opens', async () => {
    const onNext = vi.fn();
    const page = (open: boolean) => (
      <StepPager pageName="Sign in" onBack={null} onNext={open ? onNext : null} />
    );
    const el = await render(page(false));

    await act(async () => arrow(el, 'Next page').click());
    expect(onNext).not.toHaveBeenCalled();

    await act(async () => root!.render(page(true)));
    await act(async () => arrow(el, 'Next page').click());

    expect(onNext).toHaveBeenCalledOnce();
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
