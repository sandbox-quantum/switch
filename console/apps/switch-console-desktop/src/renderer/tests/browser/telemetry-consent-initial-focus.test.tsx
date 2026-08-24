import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TelemetryConsentDialog } from '@renderer/features/telemetry/TelemetryConsentDialog';
import '@renderer/index.css';

/**
 * The first-run consent prompt opened with focus on the consent switch — the
 * dialog's first tabbable element — so its `focus-visible` ring drew a
 * highlighted band around the toggle row before the user had touched anything,
 * and vanished on the first click elsewhere (CHOO-2344). Focus belongs on the
 * popup: inside the dialog, but not on an answer.
 *
 * Asserts the rendered ring, not the prop: the ring is the symptom, and only a
 * real browser with the real stylesheet resolves `focus-visible`.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function openDialog() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <TelemetryConsentDialog onAnswered={() => {}} />
      </QueryClientProvider>
    );
  });
  // Base UI moves initial focus after the open transition, not during render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

/** The switch's focusable root — `id` lands on Base UI's hidden input, not here. */
function consentSwitch(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot="switch"]');
  if (el === null) throw new Error('consent switch not rendered');
  return el;
}

describe('telemetry consent dialog initial focus', () => {
  it('does not open with the consent switch focused', async () => {
    await openDialog();

    expect(document.activeElement).not.toBe(consentSwitch());
    expect(consentSwitch().matches(':focus-visible')).toBe(false);
  });

  it('draws no focus ring around the toggle row', async () => {
    await openDialog();

    // `ring-3` compiles to a 3px box-shadow; an unfocused switch has none.
    expect(getComputedStyle(consentSwitch()).boxShadow).not.toMatch(/0px 0px 0px 3px/);
  });

  it('still moves focus into the dialog', async () => {
    await openDialog();

    const popup = document.querySelector('[data-slot="dialog-content"]');
    expect(popup).not.toBeNull();
    expect(document.activeElement).toBe(popup);
  });
});
