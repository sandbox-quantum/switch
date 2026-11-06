import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { InvitationWarnings } from '@renderer/features/locations/components/main-panel/invitation-warnings';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
});

it('renders the owner notice as text and clears it for an empty or older response', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const warning = 'Added to <private room> without a verified inviter. You can remove it.';
  await act(async () => root!.render(<InvitationWarnings warnings={[warning]} />));
  expect(container.querySelector('[role="status"]')?.textContent).toBe(warning);
  expect(container.querySelector('private')).toBeNull();
  await act(async () => root!.render(<InvitationWarnings warnings={[]} />));
  expect(container.textContent).toBe('');
  await act(async () => root!.render(<InvitationWarnings />));
  expect(container.textContent).toBe('');
});
