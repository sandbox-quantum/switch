import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingSurface, type WizardExit } from '@renderer/lib/ui/wizard-frame';
import '@renderer/index.css';

/**
 * The first-run pages fill a frameless window, and the centred page column
 * opts its whole height out of the drag region so its controls stay clickable.
 * The surface's top row is therefore the only place the window can be moved
 * by, and it has to be there whether or not the page offers a way out.
 *
 * Only Electron acts on a drag region, so — as in `home-drag-region.test.tsx` —
 * these assertions are on the markup rather than on behaviour.
 */

const DRAG = '[-webkit-app-region:drag]';
const NO_DRAG = '[-webkit-app-region:no-drag]';

let container: HTMLDivElement | null = null;

async function render(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return container;
}

async function renderSurface(exit: WizardExit | null): Promise<HTMLDivElement> {
  return render(
    <OnboardingSurface exit={exit} footer={<button type="button">Continue</button>}>
      <h1>Set up a server on this computer</h1>
    </OnboardingSurface>
  );
}

function titlebar(el: HTMLElement): HTMLElement | null {
  return el.querySelector('[data-slot="onboarding-titlebar"]');
}

afterEach(() => {
  container?.remove();
  container = null;
});

describe('onboarding drag region', () => {
  it('gives a page with no way out a draggable title bar', async () => {
    const el = await renderSurface(null);
    const bar = titlebar(el);

    expect(bar).not.toBeNull();
    expect(bar?.className).toContain(DRAG);
    expect(bar?.className).not.toContain(NO_DRAG);
    expect(bar?.getBoundingClientRect().height).toBe(44);
  });

  it('keeps the title bar draggable around the way out, and the way out clickable', async () => {
    const el = await renderSurface({ label: 'Back to the app', onExit: () => {} });
    const bar = titlebar(el);
    const exit = [...el.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Back to the app'
    );

    expect(bar?.className).toContain(DRAG);
    expect(exit).toBeDefined();
    expect(bar?.contains(exit ?? null)).toBe(true);
    expect(exit?.className).toContain(NO_DRAG);
  });

  it('keeps the page column under the title bar rather than over it', async () => {
    const el = await renderSurface(null);
    const bar = titlebar(el);
    const heading = el.querySelector('h1');

    expect(heading?.closest(`[class*="${NO_DRAG}"]`)).not.toBeNull();
    expect(bar?.contains(heading ?? null)).toBe(false);
    expect(heading!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      bar!.getBoundingClientRect().bottom
    );
  });
});
