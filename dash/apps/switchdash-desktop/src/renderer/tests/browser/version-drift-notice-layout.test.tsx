import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { VersionDriftNotice } from '@renderer/features/switch-servers/VersionDriftNotice';
import '@renderer/index.css';

/**
 * `AlertAction` used to be positioned absolutely over a fixed `pr-18` gutter,
 * which only clears the text while the action stays narrower than that gutter.
 * "Restart to update" is roughly twice as wide, so the drift description ran
 * underneath the button (CHOO-1736).
 *
 * These assertions are on measured geometry rather than class strings: the bug
 * was invisible at the markup level — every class was present and correct — and
 * only a real layout reveals the overlap.
 */

const PANEL_WIDTH = 660;

let container: HTMLDivElement | null = null;

async function renderNotice(deployed: string, expected: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  container.style.width = `${PANEL_WIDTH}px`;
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <VersionDriftNotice
        drift={{ direction: 'upgrade', deployed, expected }}
        disabled={false}
        onRestart={() => {}}
      />
    )
  );
  return container;
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

afterEach(() => {
  container?.remove();
  container = null;
});

describe('version drift notice layout', () => {
  it('keeps the restart button clear of the description text', async () => {
    const el = await renderNotice('0.11.0', '0.12.1');
    const button = el.querySelector('button');
    const description = el.querySelector('[data-slot="alert-description"]');

    expect(button).not.toBeNull();
    expect(description).not.toBeNull();

    const buttonRect = button!.getBoundingClientRect();
    const descriptionRect = description!.getBoundingClientRect();

    // Guard the guard: a zero-width button would trivially satisfy the overlap
    // check while proving nothing.
    expect(buttonRect.width).toBeGreaterThan(100);
    expect(descriptionRect.width).toBeGreaterThan(100);

    expect(rectsOverlap(buttonRect, descriptionRect)).toBe(false);
  });

  it('keeps the title clear of the restart button', async () => {
    const el = await renderNotice('0.11.0', '0.12.1');
    const button = el.querySelector('button');
    const title = el.querySelector('[data-slot="alert-title"]');

    const buttonRect = button!.getBoundingClientRect();
    const titleRect = title!.getBoundingClientRect();

    expect(rectsOverlap(buttonRect, titleRect)).toBe(false);
  });

  it('still clears the text when the version strings are long', async () => {
    const el = await renderNotice('0.11.0-rc.20260806+build.5', '0.12.1-rc.20260807+build.9');
    const button = el.querySelector('button');
    const description = el.querySelector('[data-slot="alert-description"]');

    const buttonRect = button!.getBoundingClientRect();
    const descriptionRect = description!.getBoundingClientRect();

    expect(rectsOverlap(buttonRect, descriptionRect)).toBe(false);
  });

  it('keeps the notice within its container', async () => {
    const el = await renderNotice('0.11.0', '0.12.1');
    const alert = el.querySelector('[data-slot="alert"]');
    const button = el.querySelector('button');

    const alertRect = alert!.getBoundingClientRect();
    const buttonRect = button!.getBoundingClientRect();

    expect(buttonRect.right).toBeLessThanOrEqual(alertRect.right + 0.5);
  });
});
