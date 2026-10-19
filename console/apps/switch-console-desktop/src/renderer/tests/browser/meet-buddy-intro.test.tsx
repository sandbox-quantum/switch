/**
 * Meet switch-buddy's opening plays once. Coming back to the page draws it at
 * rest, with every line there.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

import { buddyIntroLines } from '@renderer/features/switch-buddy/buddy-intro-lines';
import { MeetBuddyIntro } from '@renderer/features/switch-buddy/meet-buddy-intro';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(play: boolean, onPlayed = () => {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<MeetBuddyIntro firstName="Max" play={play} onPlayed={onPlayed} />)
  );
}

/** What each bubble shows on screen. */
function shownLines(): string[] {
  return [...container!.querySelectorAll('p > span[aria-hidden]')].map((span) =>
    [...span.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('')
  );
}

describe('Meet switch-buddy opening', () => {
  it('is drawn at rest when it has already played', async () => {
    await render(false);
    expect(container!.textContent).toContain('Meet switch-buddy');
    expect(shownLines()).toEqual(buddyIntroLines('Max'));
  });

  it('starts with the tile alone and nothing typed', async () => {
    await render(true);
    expect(shownLines()).toEqual([]);
    expect(container!.querySelectorAll('[data-intro="tile"]')).toHaveLength(1);
  });

  it('counts as seen when left part-way', async () => {
    const onPlayed = vi.fn();
    await render(true, onPlayed);
    await act(async () => root?.unmount());
    root = null;
    expect(onPlayed).toHaveBeenCalled();
  });
});
