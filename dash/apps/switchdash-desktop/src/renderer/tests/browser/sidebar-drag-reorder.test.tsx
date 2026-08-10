import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * Drag-to-reorder in the sidebar (CHOO-2007).
 *
 * The reorder *rule* is unit-tested in `sidebar-dnd.test.ts`; what only a real
 * browser can show is that a pointer drag reaches that rule at all — dnd-kit
 * needs real layout to measure droppables and real pointer events to arm its
 * sensor, and the bug being fixed was precisely a UI that no longer existed
 * rather than a rule that computed the wrong answer.
 */
import {
  AGENTS_CONTAINER,
  makeDndId,
  SortableBranch,
  SortableList,
} from '@renderer/features/sidebar/sidebar-dnd';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const ROW_HEIGHT = 40;

async function renderList(
  ids: string[],
  onReorder: (ordered: string[]) => void
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SortableList containerId={AGENTS_CONTAINER} itemIds={ids} onReorder={onReorder}>
        {ids.map((id) => (
          <SortableBranch
            key={id}
            id={makeDndId(AGENTS_CONTAINER, id)}
            header={
              <div data-row={id} style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}>
                {id}
              </div>
            }
          />
        ))}
      </SortableList>
    )
  );
  return container;
}

function row(id: string): HTMLElement {
  const el = container?.querySelector(`[data-row="${id}"]`);
  if (!el) throw new Error(`row ${id} not rendered`);
  return el as HTMLElement;
}

function centre(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function pointer(type: string, at: { x: number; y: number }, target: EventTarget): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    })
  );
}

/**
 * A pointer drag from one row onto another. The intermediate moves matter: the
 * sensor only arms once the pointer has travelled past its activation distance,
 * which is what stops a click on a row from becoming a drag.
 */
async function drag(fromId: string, toId: string): Promise<void> {
  const from = row(fromId);
  const start = centre(from);
  const end = centre(row(toId));

  await act(async () => {
    pointer('pointerdown', start, from);
  });
  // Cross the 6px activation threshold, then travel to the target.
  for (const step of [0.05, 0.25, 0.5, 0.75, 1]) {
    await act(async () => {
      pointer(
        'pointermove',
        { x: start.x + (end.x - start.x) * step, y: start.y + (end.y - start.y) * step },
        document
      );
    });
  }
  await act(async () => {
    pointer('pointerup', end, document);
  });
}

describe('sidebar drag-to-reorder', () => {
  it('reports the new order when a row is dragged past another', async () => {
    const calls: string[][] = [];
    await renderList(['agent-a', 'agent-b', 'agent-c'], (ordered) => calls.push(ordered));

    await drag('agent-a', 'agent-c');

    expect(calls).toEqual([['agent-b', 'agent-c', 'agent-a']]);
  });

  it('moves a row upwards too', async () => {
    const calls: string[][] = [];
    await renderList(['agent-a', 'agent-b', 'agent-c'], (ordered) => calls.push(ordered));

    await drag('agent-c', 'agent-a');

    expect(calls).toEqual([['agent-c', 'agent-a', 'agent-b']]);
  });

  it('does not reorder on a click', async () => {
    // Sidebar rows open pages and toggle expansion; a plain click must not be
    // read as a zero-distance drag.
    const calls: string[][] = [];
    await renderList(['agent-a', 'agent-b', 'agent-c'], (ordered) => calls.push(ordered));

    const target = row('agent-b');
    const at = centre(target);
    await act(async () => {
      pointer('pointerdown', at, target);
    });
    await act(async () => {
      pointer('pointerup', at, document);
    });

    expect(calls).toEqual([]);
  });
});
