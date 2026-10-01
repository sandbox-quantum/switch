/**
 * The first page of a fresh install.
 *
 * Its whole job is to say where Switch can run and get on with a place it can.
 * Switch Cloud is only a place when this build or run names a deployment for
 * it. When none is named the page does not mention it, and nothing on the page
 * may pretend to be a choice. When one is named it is
 * a real second way on, and the unlabelled pager must not pick between the two.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onContinue = vi.hoisted(() => vi.fn());
const onInvite = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

import { type WelcomeCloud, WelcomePage } from '@renderer/features/onboarding/welcome-page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  onContinue.mockReset();
  onInvite.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderPage(
  cloud: WelcomeCloud = { kind: 'closed' },
  onLeave: (() => void) | null = null
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <WelcomePage cloud={cloud} onContinue={onContinue} onInvite={onInvite} onLeave={onLeave} />
    )
  );
  return container;
}

function choice(el: HTMLElement, title: string): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>('li')].find((c) =>
    c.textContent?.includes(title)
  );
  expect(found, `no option named ${title}`).toBeDefined();
  return found!;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label
  );
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

describe('the welcome page with no Switch Cloud named', () => {
  it('asks where Switch should run and offers only your own server', async () => {
    const el = await renderPage();

    expect(el.textContent).toContain('Welcome to Switch');
    expect(el.textContent).toContain('Where should it run?');
    expect(choice(el, 'Your own server')).toBeDefined();
  });

  it('does not mention Switch Cloud at all', async () => {
    // Stable ships the Cloud code before the Cloud is open to it, so a build
    // with no Cloud named must not advertise one.
    const el = await renderPage();

    expect(el.textContent).not.toContain('Switch Cloud');
    expect(el.querySelectorAll('li')).toHaveLength(1);
  });

  it('does not flash a Cloud card while the configuration is read', async () => {
    const el = await renderPage({ kind: 'reading' });

    expect(el.textContent).not.toContain('Switch Cloud');
  });

  it('offers nothing to pick between, since only one answer can be had', async () => {
    // A radiogroup here was a widget with no working option in it: two
    // `role="radio"` divs, no click handler, no key handler. Announcing a
    // choice and then answering neither the keyboard nor the mouse is worse
    // than a list that never claimed to be one.
    const el = await renderPage();

    expect(el.querySelectorAll('[role="radiogroup"], [role="radio"]')).toHaveLength(0);
    // The one control on the page, and it names which of the two it takes.
    expect(button(el, 'Continue with your own server')).toBeDefined();
  });

  it('moves the flow on from Continue', async () => {
    const el = await renderPage();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(onContinue).toHaveBeenCalled();
  });

  it('offers joining from an invite link instead', async () => {
    const el = await renderPage();

    await act(async () => button(el, 'Paste your invite link').click());

    expect(onInvite).toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('sends the pager forward to the same place as Continue', async () => {
    // The arrow is unlabelled, so it may only repeat a move the page already
    // offers — never introduce one of its own.
    const el = await renderPage();

    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click());

    expect(onContinue).toHaveBeenCalled();
  });
});

function openCloud(overrides: Partial<Extract<WelcomeCloud, { kind: 'open' }>> = {}): WelcomeCloud {
  return {
    kind: 'open',
    url: 'https://cloud.example.com',
    connecting: false,
    error: null,
    onConnect: vi.fn(),
    ...overrides,
  };
}

describe('the welcome page with Switch Cloud named', () => {
  it('names where the Cloud is and does not call it coming soon', async () => {
    const el = await renderPage(openCloud());
    const cloud = choice(el, 'Switch Cloud');

    expect(cloud.textContent).toContain('cloud.example.com');
    expect(cloud.textContent).not.toContain('Coming soon');
  });

  it('connects to the Cloud from its own button', async () => {
    const onConnect = vi.fn();
    const el = await renderPage(openCloud({ onConnect }));

    await act(async () => button(el, 'Continue with Switch Cloud').click());

    expect(onConnect).toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('still offers your own server', async () => {
    const el = await renderPage(openCloud());

    await act(async () => button(el, 'Continue with your own server').click());

    expect(onContinue).toHaveBeenCalled();
  });

  it('gives the pager no forward move, since there are two to choose between', async () => {
    const el = await renderPage(openCloud());

    const next = el.querySelector<HTMLButtonElement>('[aria-label="Next page"]');
    if (next) {
      await act(async () => next.click());
    }
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('shows why connecting failed', async () => {
    const el = await renderPage(openCloud({ error: 'Could not reach Switch Cloud' }));

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not reach Switch Cloud'
    );
  });
});

describe('the welcome page when the Cloud setting is broken', () => {
  it('says the Cloud is unavailable and why, and offers no way into it', async () => {
    const el = await renderPage({
      kind: 'failed',
      headline: 'Switch Cloud is misconfigured',
      detail: 'SWITCH_CLOUD_URL must be an https URL',
    });
    const cloud = choice(el, 'Switch Cloud');

    expect(cloud.textContent).toContain('Unavailable');
    expect(cloud.textContent).toContain('SWITCH_CLOUD_URL must be an https URL');
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Switch Cloud'))
    ).toBe(false);
  });
});

describe('the welcome page opened again from a build with servers', () => {
  it('offers no way back on a fresh install, where there is no app to go back to', async () => {
    const el = await renderPage();

    expect(() => button(el, 'Back to the app')).toThrow();
  });

  it('offers a way back to the app when replayed', async () => {
    const onLeave = vi.fn();
    const el = await renderPage({ kind: 'closed' }, onLeave);

    await act(async () => button(el, 'Back to the app').click());

    expect(onLeave).toHaveBeenCalledOnce();
    expect(onContinue).not.toHaveBeenCalled();
  });
});
