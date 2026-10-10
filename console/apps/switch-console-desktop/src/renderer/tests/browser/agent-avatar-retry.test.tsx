/**
 * An agent's avatar that fails to load is tried again before the initials
 * stay: the avatar service refuses bursts, and those refusals pass.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function fail(img: HTMLImageElement) {
  await act(async () => img.dispatchEvent(new Event('error')));
}

it('tries a failed avatar again, then keeps the initials after the last try', async () => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<AgentAvatar name="Ada Lovelace" iconUrl="https://avatars.invalid/ada.svg" />)
  );

  for (let tryNumber = 0; tryNumber < 3; tryNumber++) {
    const img = container.querySelector('img');
    expect(img, `try ${tryNumber + 1} draws the image`).not.toBeNull();
    await fail(img!);
    expect(container.textContent).toBe('AL');
    await act(async () => vi.advanceTimersByTime(20_000));
  }

  await fail(container.querySelector('img')!);
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toBe('AL');
});
