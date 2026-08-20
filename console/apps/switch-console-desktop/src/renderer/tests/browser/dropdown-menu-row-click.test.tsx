import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
/**
 * A dropdown menu inside a clickable row (CHOO-2173).
 *
 * Base UI portals the popup out of the DOM but not out of the React tree, so a
 * click on a menu item still bubbles to whatever the trigger sits inside. On a
 * sidebar row that meant the row's own handler ran straight after the item's:
 * pick Delete on a session and the row reopened the session on top of it, so
 * every action in that menu looked dead while the same action on the right-click
 * menu — a sibling of the row, not a child — worked.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

/** A row that does something when clicked, with an actions menu on it — the
 * shape every session and room row in the sidebar has. */
function row({ onRowClick, onDelete }: { onRowClick: () => void; onDelete: () => void }) {
  return (
    <div onClick={onRowClick} onMouseDown={(e) => e.preventDefault()}>
      <span>A session</span>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Actions for session" onClick={(e) => e.stopPropagation()}>
          Actions
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onDelete}>Delete…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

async function openMenu(el: HTMLElement): Promise<void> {
  const trigger = el.querySelector<HTMLElement>('[aria-label="Actions for session"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label
  );
  expect(found, `no menu item labelled ${label}`).toBeDefined();
  return found!;
}

describe('a dropdown menu on a clickable row', () => {
  it('runs the action the item was given', async () => {
    const onDelete = vi.fn();
    const el = await render(row({ onRowClick: () => {}, onDelete }));
    await openMenu(el);

    await act(async () => menuItem('Delete…').click());

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not also click the row underneath it', async () => {
    const onRowClick = vi.fn();
    const el = await render(row({ onRowClick, onDelete: () => {} }));
    await openMenu(el);

    await act(async () => menuItem('Delete…').click());

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('opens without clicking the row either', async () => {
    const onRowClick = vi.fn();
    const el = await render(row({ onRowClick, onDelete: () => {} }));

    await openMenu(el);

    expect(onRowClick).not.toHaveBeenCalled();
  });
});
