import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties, ReactNode } from 'react';
import { setSidebarRowDragging } from './sidebar-drag-state';

/**
 * Drag-to-reorder plumbing for the sidebar's two top-level lists: the agents in
 * the agent view and the rooms in the room view.
 *
 * Every draggable carries a composite id `${containerId}~~${itemId}`. The
 * container id identifies the sibling set an item belongs to; reordering is
 * restricted to within a container so a drag can only change order, never move
 * an item into a different list.
 */
const SEP = '~~';

/** The reorderable sibling sets. Only the top level of each view is draggable. */
export const AGENTS_CONTAINER = 'agents';
export const ROOMS_CONTAINER = 'rooms';

export function makeDndId(containerId: string, itemId: string): string {
  return `${containerId}${SEP}${itemId}`;
}

export function parseDndId(dndId: string): { containerId: string; itemId: string } | null {
  const idx = dndId.indexOf(SEP);
  if (idx === -1) return null;
  return { containerId: dndId.slice(0, idx), itemId: dndId.slice(idx + SEP.length) };
}

/**
 * Collision detection that only considers droppables in the same container as
 * the active item, so a drag can only land among its own siblings.
 */
const sameContainerCollision: CollisionDetection = (args) => {
  const active = parseDndId(String(args.active.id));
  if (!active) return [];
  const droppableContainers = args.droppableContainers.filter((container) => {
    const parsed = parseDndId(String(container.id));
    return parsed?.containerId === active.containerId;
  });
  return closestCenter({ ...args, droppableContainers });
};

/**
 * The order `ids` takes when the item dragged from `activeId` is dropped on
 * `overId`, or null when the drop is a no-op (same slot, foreign container, or
 * an id that is no longer in the list).
 *
 * Split out from the drag handler so the reorder rule is testable without a DOM
 * or a pointer.
 */
export function reorderOnDrop(
  ids: readonly string[],
  activeId: string,
  overId: string
): string[] | null {
  const from = parseDndId(activeId);
  const to = parseDndId(overId);
  if (!from || !to || from.containerId !== to.containerId) return null;
  const oldIndex = ids.indexOf(from.itemId);
  const newIndex = ids.indexOf(to.itemId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return null;
  return arrayMove([...ids], oldIndex, newIndex);
}

function useSortableRow(id: string) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    position: 'relative',
    zIndex: isDragging ? 1 : undefined,
  };
  return { setNodeRef, style, listeners };
}

/**
 * One draggable top-level row. Only `header` is the drag handle: `children`
 * (the row's expanded subtree) moves with it but does not start a drag, so
 * dragging inside an expanded agent or room does nothing rather than picking up
 * the whole branch by surprise.
 */
export function SortableBranch({
  id,
  header,
  children,
}: {
  id: string;
  header: ReactNode;
  children?: ReactNode;
}) {
  const { setNodeRef, style, listeners } = useSortableRow(id);
  return (
    // The 2px gap is the same at every level, including between a branch's
    // header and its children: an extra step around groups would read as
    // stacked blocks rather than one tree.
    <div ref={setNodeRef} style={style} className="flex flex-col gap-[2px]">
      <div {...listeners}>{header}</div>
      {children}
    </div>
  );
}

/**
 * Wraps one top-level list in the drag context that reorders it. `itemIds` is
 * the list as currently rendered; `onReorder` receives the new order on drop.
 */
export function SortableList({
  containerId,
  itemIds,
  onReorder,
  children,
}: {
  containerId: string;
  itemIds: string[];
  onReorder: (orderedItemIds: string[]) => void;
  children: ReactNode;
}) {
  // A short activation distance keeps a click a click: rows open pages, toggle
  // expansion and open context menus, and none of that may become a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragEnd(event: DragEndEvent) {
    setSidebarRowDragging(false);
    const { active, over } = event;
    if (!over) return;
    const reordered = reorderOnDrop(itemIds, String(active.id), String(over.id));
    if (reordered) onReorder(reordered);
  }

  // The drag is announced to the rest of the sidebar because dnd-kit measures
  // every droppable when it starts: anything that scrolls the list before the
  // drop desyncs those rects and the row lands in the wrong slot.
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sameContainerCollision}
      onDragStart={() => setSidebarRowDragging(true)}
      onDragCancel={() => setSidebarRowDragging(false)}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={itemIds.map((itemId) => makeDndId(containerId, itemId))}
        strategy={verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}
