/** The Rename and Delete icons beside an agent's name. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentIdentityActions } from '@renderer/features/agent-identity/agent-identity-actions';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(props: Parameters<typeof AgentIdentityActions>[0]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <TooltipProvider>
        <AgentIdentityActions {...props} />
      </TooltipProvider>
    )
  );
}

function control(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

it('offers both, each named for screen readers, and calls back', async () => {
  const onRename = vi.fn();
  const onDelete = vi.fn();
  await render({ onRename, onDelete, disabled: false });

  await act(async () => control('Rename agent')!.click());
  await act(async () => control('Delete agent')!.click());

  expect(onRename).toHaveBeenCalledOnce();
  expect(onDelete).toHaveBeenCalledOnce();
  // Icons only: the label is for assistive tech and the tooltip, not the button text.
  expect(control('Rename agent')!.textContent).toBe('');
});

it('leaves out what is not available', async () => {
  await render({ onRename: null, onDelete: vi.fn(), disabled: false });

  expect(control('Rename agent')).toBeNull();
  expect(control('Delete agent')).not.toBeNull();
});

it('disables both while the page has unsaved edits', async () => {
  await render({ onRename: vi.fn(), onDelete: vi.fn(), disabled: true });

  expect(control('Rename agent')!.disabled).toBe(true);
  expect(control('Delete agent')!.disabled).toBe(true);
});
