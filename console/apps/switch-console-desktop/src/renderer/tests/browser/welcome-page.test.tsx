/**
 * The first page of a fresh install.
 *
 * Its whole job is to say where Switch can run and get on with the one place it
 * can. So what matters is that the place nobody can use yet — Switch Cloud has
 * no endpoint behind it — says so in words rather than only in grey, that
 * nothing on the page pretends to be a choice, and that the place that does
 * work leads somewhere rather than sitting there.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showModal = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (props: unknown) => showModal(id, props),
}));

import { WelcomePage } from '@renderer/features/onboarding/welcome-page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  showModal.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderPage(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<WelcomePage />));
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

describe('the welcome page', () => {
  it('asks where Switch should run and offers both places', async () => {
    const el = await renderPage();

    expect(el.textContent).toContain('Welcome to Switch');
    expect(el.textContent).toContain('Where should it run?');
    expect(choice(el, 'Switch Cloud')).toBeDefined();
    expect(choice(el, 'Your own server')).toBeDefined();
  });

  it('says in words that Switch Cloud is not ready, not only in grey', async () => {
    // Nothing hosts it yet. Shown anyway, because "where should it run" has two
    // answers and one of them is not ready — but the reason has to be legible
    // to someone who cannot see the card is dimmed.
    const el = await renderPage();
    const cloud = choice(el, 'Switch Cloud');

    expect(cloud.textContent).toContain('Coming soon');
    expect(cloud.textContent).toContain('there is nothing to sign in to');
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

  it('opens the add-server flow from the button', async () => {
    const el = await renderPage();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(showModal).toHaveBeenCalledWith('addServerModal', {});
  });

  it('sends the pager forward to the same place as Continue', async () => {
    // The arrow is unlabelled, so it may only repeat a move the page already
    // offers — never introduce one of its own.
    const el = await renderPage();

    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click());

    expect(showModal).toHaveBeenCalledWith('addServerModal', {});
  });
});
