import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import '@renderer/index.css';

/**
 * The body's cap used to be a constant standing in for the header and footer,
 * which over-reserved by ~80px on a normal window and would have under-reserved
 * had the footer ever grown a row — putting content back underneath it
 * (CHOO-2243). `ModalLayout` measures them instead and publishes the total as
 * `--modal-chrome`.
 *
 * Geometry, not class strings: the point is that the popup's own cap is
 * respected, which only a real layout can show.
 */

const POPUP_HEIGHT = 400;
const HEADER_HEIGHT = 40;
const SHORT_FOOTER = 56;
const TALL_FOOTER = 120;

/**
 * Sub-pixel residue from the body wrapper's height animation, which a loaded CI
 * runner can leave a fraction short. The regression here is the footer pushed
 * clean out of the popup, so a couple of pixels of slack costs nothing.
 */
const TOLERANCE = 2;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({ footerHeight }: { footerHeight: number }) {
  return (
    <div
      data-testid="popup"
      style={{
        display: 'flex',
        flexDirection: 'column',
        maxHeight: `${POPUP_HEIGHT}px`,
        overflow: 'hidden',
        width: '480px',
      }}
    >
      <ModalLayout
        header={<div data-testid="header" style={{ height: `${HEADER_HEIGHT}px` }} />}
        footer={<div data-testid="footer" style={{ height: `${footerHeight}px` }} />}
      >
        <div
          data-testid="body"
          style={{
            overflowY: 'auto',
            maxHeight: `calc(${POPUP_HEIGHT}px - var(--modal-chrome, 136px))`,
          }}
        >
          <div style={{ height: '2000px' }} />
        </div>
      </ModalLayout>
    </div>
  );
}

async function render(footerHeight: number): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness footerHeight={footerHeight} />));
  await settle();
  return container;
}

async function rerender(footerHeight: number): Promise<void> {
  await act(async () => root!.render(<Harness footerHeight={footerHeight} />));
  await settle();
}

/** Wait for the body wrapper to stop animating rather than sleeping a fixed
 * span: easing crawls at the end, so one repeated read is not proof it is over. */
async function settle(): Promise<void> {
  const footer = container?.querySelector('[data-testid="footer"]');
  let previous = -1;
  let stableReads = 0;
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    if (!footer) continue;
    const current = Math.round(footer.getBoundingClientRect().top);
    stableReads = current === previous ? stableReads + 1 : 0;
    previous = current;
    if (stableReads >= 3) return;
  }
}

function bottomOf(el: Element): number {
  return el.getBoundingClientRect().bottom;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('ModalLayout chrome reservation', () => {
  it('reserves exactly what the header and footer measure', async () => {
    const el = await render(SHORT_FOOTER);
    const body = el.querySelector('[data-testid="body"]')!;

    expect(getComputedStyle(body).getPropertyValue('--modal-chrome').trim()).toBe(
      `${HEADER_HEIGHT + SHORT_FOOTER}px`
    );
    expect(getComputedStyle(body).maxHeight).toBe(
      `${POPUP_HEIGHT - HEADER_HEIGHT - SHORT_FOOTER}px`
    );
  });

  it('keeps the footer inside the popup when the body is taller than the space', async () => {
    const el = await render(SHORT_FOOTER);
    const popup = el.querySelector('[data-testid="popup"]')!;
    const footer = el.querySelector('[data-testid="footer"]')!;
    const body = el.querySelector('[data-testid="body"]')!;

    // Guard the guard: a body that fits would satisfy this without the cap
    // doing any work.
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);

    expect(bottomOf(footer)).toBeLessThanOrEqual(bottomOf(popup) + TOLERANCE);
    expect(bottomOf(body)).toBeLessThanOrEqual(footer.getBoundingClientRect().top + TOLERANCE);
  });

  it('follows the footer when it grows a row', async () => {
    const el = await render(SHORT_FOOTER);
    await rerender(TALL_FOOTER);

    const popup = el.querySelector('[data-testid="popup"]')!;
    const footer = el.querySelector('[data-testid="footer"]')!;
    const body = el.querySelector('[data-testid="body"]')!;

    expect(getComputedStyle(body).getPropertyValue('--modal-chrome').trim()).toBe(
      `${HEADER_HEIGHT + TALL_FOOTER}px`
    );
    expect(bottomOf(footer)).toBeLessThanOrEqual(bottomOf(popup) + TOLERANCE);
    expect(bottomOf(body)).toBeLessThanOrEqual(footer.getBoundingClientRect().top + TOLERANCE);
  });
});
