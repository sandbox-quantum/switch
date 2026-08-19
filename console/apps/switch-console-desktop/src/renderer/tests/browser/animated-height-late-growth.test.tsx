import { useEffect, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AnimatedHeight } from '@renderer/lib/ui/animated-height';
import '@renderer/index.css';

/**
 * `AnimatedHeight` pins its wrapper to a measured pixel height and, while idle,
 * lets content overflow that box visibly. It used to discard the
 * ResizeObserver's first delivery on the theory that the synchronous mount
 * measurement had already captured the size. Content that grows between those
 * two moments — the New agent modal opens its Settings section by itself once
 * the messaging-app lookup settles, which on a warm cache lands in the same
 * commit as mount — is reported only in that discarded callback, so the wrapper
 * stayed short and the body painted on underneath the modal's footer
 * (CHOO-2243).
 *
 * These assertions are on measured geometry, not class strings: every class was
 * correct while the bug was live, and only a real layout shows the content
 * escaping its box.
 */

const CONTENT_WIDTH = 480;
const INITIAL_HEIGHT = 200;
const GROWN_HEIGHT = 420;
const FOOTER_HEIGHT = 56;

/**
 * Sub-pixel residue from the height animation, which a loaded CI runner can
 * leave a fraction short of its target. The regression this guards against is
 * two orders of magnitude larger — the wrapper stuck at its pre-growth height —
 * so a couple of pixels of slack costs the assertions nothing.
 */
const TOLERANCE = 2;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Mirrors ModalLayout: header, AnimatedHeight-wrapped body, footer. */
function GrowsOnMount({ grow }: { grow: boolean }) {
  const [tall, setTall] = useState(false);

  // Growing from an effect on mount is the timing that matters: it commits
  // before the observer's first delivery, so that delivery is the only report
  // of the new size.
  useEffect(() => {
    if (grow) setTall(true);
  }, [grow]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: `${CONTENT_WIDTH}px` }}>
      <div data-testid="header" style={{ flexShrink: 0, height: '40px' }} />
      <AnimatedHeight>
        <div data-testid="body" style={{ height: `${tall ? GROWN_HEIGHT : INITIAL_HEIGHT}px` }} />
      </AnimatedHeight>
      <div data-testid="footer" style={{ flexShrink: 0, height: `${FOOTER_HEIGHT}px` }} />
    </div>
  );
}

async function render(grow: boolean): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<GrowsOnMount grow={grow} />));
  return container;
}

function wrapperOf(el: HTMLDivElement): HTMLElement {
  const body = el.querySelector('[data-testid="body"]');
  // body -> contentRef div -> motion.div
  return body!.parentElement!.parentElement as HTMLElement;
}

/**
 * The wrapper animates to each new height, so measure only once it has stopped
 * moving. Polling rather than sleeping a fixed span keeps the assertions off
 * the animation's timing: a wrapper that never tracks its content settles just
 * as readily, at the wrong height.
 */
async function settle(el: HTMLDivElement): Promise<void> {
  const wrapper = wrapperOf(el);
  let previous = -1;
  let stableReads = 0;
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const current = Math.round(wrapper.getBoundingClientRect().height);
    // Easing crawls at the end, so a single repeated read is not proof the
    // animation is over — one starved frame looks the same.
    stableReads = current === previous ? stableReads + 1 : 0;
    previous = current;
    if (stableReads >= 3) return;
  }
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('AnimatedHeight late growth', () => {
  it('tracks content that grows in the same commit as mount', async () => {
    const el = await render(true);
    await settle(el);

    const wrapper = wrapperOf(el);
    const body = el.querySelector('[data-testid="body"]')!;

    // Guard the guard: a body that never grew would satisfy the containment
    // check below while proving nothing.
    expect(body.getBoundingClientRect().height).toBeCloseTo(GROWN_HEIGHT, 0);
    expect(Math.abs(wrapper.getBoundingClientRect().height - GROWN_HEIGHT)).toBeLessThanOrEqual(
      TOLERANCE
    );
  });

  it('keeps grown content inside its box, clear of what follows', async () => {
    const el = await render(true);
    await settle(el);

    const wrapper = wrapperOf(el);
    const footer = el.querySelector('[data-testid="footer"]')!;
    const body = el.querySelector('[data-testid="body"]')!;

    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    // The content must not spill past the box that positions the footer, and
    // must not reach into the footer itself.
    expect(bodyRect.bottom).toBeLessThanOrEqual(wrapper.getBoundingClientRect().bottom + TOLERANCE);
    expect(bodyRect.bottom).toBeLessThanOrEqual(footerRect.top + TOLERANCE);
  });

  it('leaves a wrapper whose content never changed at its measured height', async () => {
    const el = await render(false);
    await settle(el);

    expect(
      Math.abs(wrapperOf(el).getBoundingClientRect().height - INITIAL_HEIGHT)
    ).toBeLessThanOrEqual(TOLERANCE);
  });
});
