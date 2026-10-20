/**
 * The intro stands in front of Welcome on a first run, and in front of the
 * whole app once for an install onboarded before it existed. Either way it
 * must give way: on Esc, and when it cannot draw at all.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sequence = vi.hoisted(() => ({ broken: false }));

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));
vi.mock('@renderer/features/onboarding/intro/IntroSequence', () => ({
  IntroSequence: () => {
    if (sequence.broken) throw new Error('intro asset failed');
    return <div data-testid="intro-sequence" />;
  },
}));

import { OnboardingIntro } from '@renderer/features/onboarding/onboarding-intro';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  sequence.broken = false;
});

async function renderIntro(onDone: () => void): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<OnboardingIntro onDone={onDone} />));
  return container;
}

describe('the intro', () => {
  it('gives way on Esc', async () => {
    const onDone = vi.fn();
    const el = await renderIntro(onDone);
    expect(el.querySelector('[data-testid="intro-sequence"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('counts as done, rather than blocking, when it fails to draw', async () => {
    sequence.broken = true;
    const onDone = vi.fn();
    const el = await renderIntro(onDone);

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toContain('Skip');
  });
});
